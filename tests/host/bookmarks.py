"""Bookmark document checks against the disposable real Jellyfin HTTP pipeline."""
import json


def prepare(host, prefix, regular, restricted, admin, item_id):
    token = regular['AccessToken']
    route = f"{prefix}/user-settings/{regular['User']['Id']}/bookmark-document"
    first_id, final_id = 'HOST-Bookmark-A', 'HOST-Bookmark-B'
    extension = {'large': 10**45 + 7, 'nested': ['2026-11-07T10:20:30.000Z', {'retained': True}]}
    created_label = '2026-11-07T10:20:30.000Z'

    def read():
        return host.request(route, token=token)

    def field(value, name):
        matches = [v for k, v in value.items() if k.lower() == name.lower()]
        assert len(matches) == 1, f'Expected one {name} field'
        return matches[0]

    def records(snapshot):
        return field(json.loads(snapshot['Document']), 'bookmarks')

    def same_bootstrap():
        snapshot = read()
        bootstrap = host.request(prefix + '/bootstrap', token=token)
        assert bootstrap['UserSettings']['BookmarkSnapshot'] == snapshot

    host.check('anonymous bookmark read denied', lambda: host.request(route, expected=401))
    host.check('anonymous bookmark mutation denied', lambda: host.request(route, 'POST',
        {'Revision': 'missing', 'Operations': [{'Kind': 'delete-all'}]}, expected=401))
    for user in [regular, restricted]:
        other = f"{prefix}/user-settings/{admin['User']['Id']}/bookmark-document"
        host.check('guarded bookmark cross-user read denied ' + user['User']['Name'],
            lambda user=user: host.request(other, token=user['AccessToken'], expected=403))
        host.check('guarded bookmark cross-user mutation denied ' + user['User']['Name'],
            lambda user=user: host.request(other, 'POST', {'Revision': 'missing', 'Operations': [{'Kind': 'delete-all'}]}, user['AccessToken'], expected=403))
    host.check('missing bookmark snapshot agrees with bootstrap', same_bootstrap)
    initial = read()
    assert initial['Revision'] == 'missing'

    def create():
        receipt = host.request(route, 'POST', {'Revision': initial['Revision'], 'Operations': [
            {'Kind': 'create', 'Id': first_id, 'Fields': {'ItemId': item_id, 'Timestamp': 0.25,
             'Label': created_label, 'futureExtension': extension}}]}, token)
        actual = read()
        assert receipt['Revision'] == actual['Revision'] != initial['Revision']
        record = records(actual)[first_id]
        assert field(record, 'label') == created_label
        assert record['futureExtension'] == extension
    host.check('guarded bookmark create preserves exact label and nested extension', create)
    before_edit = read()
    creation = field(records(before_edit)[first_id], 'createdAt')

    def edit():
        receipt = host.request(route, 'POST', {'Revision': before_edit['Revision'], 'Operations': [
            {'Kind': 'edit', 'Id': first_id, 'ExpectedItemId': item_id, 'Fields': {'Label': 'edited'}}]}, token)
        actual = read()
        assert receipt['Revision'] == actual['Revision'] != before_edit['Revision']
        assert field(records(actual)[first_id], 'label') == 'edited'
        assert records(actual)[first_id]['futureExtension'] == extension
    host.check('guarded bookmark edit advances revision and preserves metadata', edit)

    def conflict_and_atomicity():
        before = read()
        host.request(route, 'POST', {'Revision': before_edit['Revision'], 'Operations': [
            {'Kind': 'edit', 'Id': first_id, 'Fields': {'Label': 'stale'}}]}, token, expected=409)
        assert read() == before
        host.request(route, 'POST', {'Revision': before['Revision'], 'Operations': [
            {'Kind': 'edit', 'Id': first_id, 'Fields': {'Label': 'partial'}},
            {'Kind': 'delete', 'Id': 'missing-record'}]}, token, expected=400)
        assert read() == before
    host.check('stale bookmark writes and invalid batches leave document unchanged', conflict_and_atomicity)

    def replace():
        snapshot = read()
        host.request(route, 'POST', {'Revision': snapshot['Revision'], 'Operations': [
            {'Kind': 'replace', 'Id': final_id, 'SourceId': first_id, 'ExpectedItemId': item_id,
             'Offset': 0.25, 'Fields': {'ItemId': item_id, 'Label': 'replacement'}}]}, token)
        actual = records(read())
        assert first_id not in actual
        assert field(actual[final_id], 'timestamp') == 0.5
        assert field(actual[final_id], 'createdAt') == creation
        assert actual[final_id]['futureExtension'] == extension
    host.check('bookmark replacement preserves stored metadata and offsets', replace)
    host.check('bookmark bootstrap agrees after mutation and conflict', same_bootstrap)

    def admin_read():
        assert host.request(route, token=admin['AccessToken']) == read()
    host.check('administrator can read guarded bookmark document', admin_read)

    def legacy_conflict():
        before = read()
        restricted_route = f"{prefix}/user-settings/{restricted['User']['Id']}"
        snapshot = host.request(restricted_route + '/bookmark-document', token=restricted['AccessToken'])
        host.request(restricted_route + '/bookmark.json', 'POST', {'Bookmarks': {}}, restricted['AccessToken'])
        host.request(restricted_route + '/bookmark-document', 'POST', {'Revision': snapshot['Revision'],
            'Operations': [{'Kind': 'delete-all'}]}, restricted['AccessToken'], expected=409)
        assert read() == before
    host.check('legacy bookmark write invalidates guarded revision without changing another user', legacy_conflict)
    persisted_revision = read()['Revision']

    def persisted(label='replacement', require_revision=True):
        actual = read()
        record = records(actual)[final_id]
        assert first_id not in records(actual)
        assert field(record, 'label') == label
        assert field(record, 'timestamp') == 0.5
        assert field(record, 'createdAt') == creation
        assert record['futureExtension'] == extension
        if require_revision:
            assert actual['Revision'] == persisted_revision
        same_bootstrap()
    return persisted, {'username': regular['User']['Name'], 'id': final_id,
                       'timestamp': 0.5, 'label': 'replacement', 'savedLabel': created_label}

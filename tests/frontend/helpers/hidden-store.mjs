// The settings store's side of Hidden Content for tests that load the Hidden Content modules without the bundle's settings
// store (enhanced/config.js). In the bundle a change leaves through internal.persist (hidden-content-save.js: one PATCH on
// the document's queue) and the store publishes the document it now shows (queued) to every follower that observes it
// (JE.internals.observeUserDocument): the data module's lookup sets and the page follow that publication. This applies a
// persisted operation ({upsert, remove, set}) to the person's document and publishes it the same way; `record` sees each
// operation (the test's write log). Install it before the data module registers (resetFromUserConfig).
export function hiddenContentStore(h, record = () => {}) {
  const followers = new Map();
  const internals = h.JE.internals = h.JE.internals || {};
  internals.observeUserDocument = (file, key, follow) => {
    if (file !== 'hidden-content.json') return () => {};
    followers.set(key, follow);
    return () => followers.delete(key);
  };
  return {
    persist(operation) {
      const document = structuredClone(h.JE.userConfig?.hiddenContent || {});
      document.items = document.items || {};
      document.settings = document.settings || {};
      for (const key of operation?.remove || []) delete document.items[key];
      Object.assign(document.items, structuredClone(operation?.upsert || {}));
      Object.assign(document.settings, structuredClone(operation?.set || {}));
      h.JE.userConfig = { ...(h.JE.userConfig || {}), hiddenContent: document };
      record(operation);
      for (const follow of [...followers.values()]) follow(structuredClone(document), 'queued');
      return Promise.resolve(true);
    },
  };
}

(() => {
"use strict";
(() => {
  // client/src/features/media-tags/admin/host.ts
  var host = () => window;
  function adminBridge() {
    const JE = host().JellyfinEnhanced;
    if (!JE) throw new TypeError("Jellyfin Enhanced must load before the Media Tags admin tab");
    return JE;
  }
  function adminTagsApi(JE) {
    const facade = JE.adminTags;
    return facade && isCore(facade) ? facade : null;
  }
  function isCore(facade) {
    return typeof facade.registerSection === "function" && typeof facade.fmt === "function" && Array.isArray(facade.sections);
  }

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/people.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'groups',
      title: 'People',
      group: { id: 'people' },
          { id: 'peopleTagsEnabled', key: 'PeopleTagsEnabled', type: 'enable', label: 'People tags for new users' },
  */
  installSection((A) => {
    A.registerSection({
      id: "group-people",
      tab: "groups",
      order: 70,
      title: "People",
      hint: "Age and birthplace on cast members' cards on detail pages.",
      group: {
        id: "people",
        summary: () => A.fmt("Age and birthplace on cast cards")
      },
      fields: [
        { id: "peopleTagsEnabled", key: "PeopleTagsEnabled", type: "enable", label: "People tags for new users" }
      ]
    });
  });
})();
})();
//# sourceMappingURL=people.js.map

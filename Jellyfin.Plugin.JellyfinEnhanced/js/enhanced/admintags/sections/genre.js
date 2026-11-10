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

  // client/src/features/media-tags/admin/sections/genre.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'groups',
      title: 'Genre',
      group: { id: 'genre' },
      writes: ['TagGroupScopes'],
          { id: 'genreTagsEnabled', key: 'GenreTagsEnabled', type: 'enable', label: 'Genre tags for new users' },
  */
  installSection((A) => {
    A.registerSection({
      id: "group-genre",
      tab: "groups",
      order: 20,
      title: "Genre",
      hint: "Themed icons for the genres of a title, with the names on hover.",
      group: {
        id: "genre",
        summary: () => A.fmt("Themed icons, names on hover"),
        sample: () => [["icon", "theater_comedy"]]
      },
      // "Where to show" (drawn for every group row by admin-tags.js).
      writes: ["TagGroupScopes"],
      fields: [
        { id: "genreTagsEnabled", key: "GenreTagsEnabled", type: "enable", label: "Genre tags for new users" }
      ]
    });
  });
})();
})();
//# sourceMappingURL=genre.js.map

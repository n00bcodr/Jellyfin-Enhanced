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

  // client/src/features/media-tags/admin/sections/agerating.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'groups',
      title: 'Age Rating',
      group: { id: 'ageRating' },
      writes: ['TagGroupScopes'],
          { id: 'ageRatingTagsEnabled', key: 'AgeRatingTagsEnabled', type: 'enable', label: 'Age rating tags for new users' },
  */
  installSection((A) => {
    A.registerSection({
      id: "group-age-rating",
      tab: "groups",
      order: 50,
      title: "Age Rating",
      hint: "The age rating (PG-13, TV-MA, FSK 12…) as a badge coloured by its board. Episodes and seasons use their series' rating.",
      group: {
        id: "ageRating",
        summary: () => A.fmt("Colour-coded by board"),
        sample: () => [["age", "PG-13"]]
      },
      // "Where to show" (drawn for every group row by admin-tags.js).
      writes: ["TagGroupScopes"],
      fields: [
        { id: "ageRatingTagsEnabled", key: "AgeRatingTagsEnabled", type: "enable", label: "Age rating tags for new users" }
      ]
    });
  });
})();
})();
//# sourceMappingURL=agerating.js.map

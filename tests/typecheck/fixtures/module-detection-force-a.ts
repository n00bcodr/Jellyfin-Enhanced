// moduleDetection force (no error expected): a file without import or export is still a module, so the same
// top-level name in two such files does not collide.
const sameName = 1;
void sameName;

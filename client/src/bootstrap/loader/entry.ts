import { installReplaceChildren } from './polyfills';
import { createBootDependencies, createInitializer } from './boot';
import { loadLoginImageEarly, loadSplashScreenEarly, registerWholePixelProperties } from './early';
import { createNamespace } from './namespace';

installReplaceChildren();
const dependencies = createBootDependencies(createNamespace());
registerWholePixelProperties();
loadSplashScreenEarly(dependencies.JE);
loadLoginImageEarly(dependencies.contracts, dependencies.identity);
void createInitializer(dependencies)();

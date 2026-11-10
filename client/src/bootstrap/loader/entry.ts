import { createBootDependencies, createInitializer } from './boot';
import { loadLoginImageEarly, loadSplashScreenEarly } from './early';
import { createNamespace } from './namespace';

const dependencies = createBootDependencies(createNamespace());
loadSplashScreenEarly(dependencies.JE);
loadLoginImageEarly(dependencies.contracts, dependencies.identity);
void createInitializer(dependencies)();

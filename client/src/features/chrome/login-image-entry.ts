import { preLoginChromeContext, ensureBridge, hostClient } from './host';
import { createLoginImage, type LoginClient, type LoginImageBridge } from './login-image';

const loginImage = createLoginImage(() => hostClient<LoginClient>());
preLoginChromeContext(ensureBridge<LoginImageBridge>(), ['initializeLoginImage']).own.initializeLoginImage = loginImage.initializeLoginImage;
// Start immediately when the script loads.
loginImage.initializeLoginImage();

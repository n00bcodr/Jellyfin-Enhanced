(() => {
"use strict";(()=>{function n(){let e=window,r=e.JellyfinEnhanced;if(!r)throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");return{JE:r,window:e,document,apiClient:()=>e.ApiClient,liveBridge:()=>e.JellyfinEnhanced}}var{JE:t}=n(),o=t.core?.api?.manager;if(!o)throw new Error("Seerr request manager loaded before the core API client");t.requestManager=o;})();
})();

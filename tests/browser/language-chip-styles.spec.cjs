const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { brotliDecompressSync } = require('node:zlib');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced');
const fixture = require('../fixtures/language-chip-styles.json');
const en = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');
const font = brotliDecompressSync(readFileSync(path.join(root, 'Assets/PosterTags/fonts/NotoSans-Bold.ttf.br'))).toString('base64');
test.use({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false });

for (const [index, preset] of fixture.presets.entries()) {
  test(`language Codes, CC, SDH and Multi share the chip base under ${preset.id}${preset.document ? ' with label colours' : ''}`, async ({ page }) => {
    await page.setContent(`<style>@font-face {font-family: 'Noto Sans'; font-weight:700; src:url(data:font/ttf;base64,${font})} body{font-family:'Noto Sans';background:#334}.cardScalable{position:relative;width:180px;height:270px}.je-tag-host{position:absolute;inset:0;container-type:inline-size}</style><div class="card"><div class="cardScalable"><div class="je-tag-host"></div></div></div>`);
    await page.evaluate(en => {
      window.JellyfinEnhanced = { currentSettings: { tagLayoutSettingsVersion:1, tagGroupCaps:{language:10}, languageTagsEnabled:true, languageTagsStyle:'codes', languageTagsShowSubtitles:true, languageTagsCountBadge:'both' }, pluginConfig:{}, helpers:{}, t:key=>en[key]||key,
        tagPipeline:{registerRenderer(name,r){r.injectCss?.()},clearProcessed(){},scheduleScan(){}} };
    }, en);
    for (const file of ['core/ui-kit.js','core/tag-renderer-base.js','core/tag-layout.js','core/media-language.js','tags/tag-layout-styles.js','tags/qualitytags.js','tags/languagetags.js','tags/tag-styles.js']) await page.addScriptTag({path:path.join(root,'js',file)});
    await page.evaluate(({fixture,index}) => {
      const JE = JellyfinEnhanced, row = fixture.presets[index], host = document.querySelector('.je-tag-host');
      JE.initializeQualityTags(); JE.initializeLanguageTags();
      const group = JE.core.languageTags.buildGroup({audio:['en',{code:'ja',partial:true},'fr'],subtitles:[{code:'en'},{code:'fr',sdh:true}]},0);
      // Use the same displayed language in both CC and SDH fixtures.
      const sdh = JE.core.languageTags.buildGroup({audio:[],subtitles:[{code:'en',sdh:true}]},0).lastChild;
      group.lastChild.replaceWith(sdh);
      JE.core.tagLayout.commitGroup(host,'language',group);
      const quality = document.createElement('div'); quality.className='quality-overlay-container';
      for (const data of fixture.chips) { const q=document.createElement('span');q.className='quality-overlay-label';q.textContent=data.text;quality.append(q); }
      JE.core.tagLayout.commitGroup(host,'quality',quality);
      const colour = v => v?.startsWith('#') ? `rgba(${[1,3,5].map(i=>parseInt(v.slice(i,i+2),16)).join(', ')}, 1)` : v;
      const web = c=>({background:colour(c.background),border:colour(c.border),color:colour(c.text)});
      const own = row.document?.labels || {}, shared = row.document?.groups?.language || {};
      const model = {preset:row.id,language:web(row.id==='poster' ? {} : {background:shared.background||row.background,border:shared.border||row.border,text:shared.text||row.text}),languageLabels:Object.fromEntries(Object.entries(own).map(([key,c])=>[key.slice(9),web(c)]))};
      if(row.id==='poster') { host.dataset.jePosterColour='';host.style.setProperty('--je-tag-bg','rgb(80,30,30)');host.style.setProperty('--je-tag-border','rgb(120,60,60)');host.style.setProperty('--je-tag-fg','rgb(255,255,255)'); }
      const style=document.createElement('style');style.textContent=JE.tagStyles.buildCss(model);document.head.append(style);
    }, {fixture,index});
    await page.evaluate(() => document.fonts.load('700 12px "Noto Sans"'));
    await expect(page.locator('.language-code[data-lang="ja"]')).toHaveCSS('opacity', '0.55');
    await expect(page.locator('.language-code[data-lang="ja"]')).toHaveCSS('outline-style', 'none');
    const pairs = await page.evaluate(() => {
      const props=['paddingTop','paddingRight','borderRadius','borderWidth','fontFamily','fontWeight','fontSize','lineHeight','fontVariantCaps','boxShadow'];
      const chips=[...document.querySelectorAll('.language-chip')];
      return [...document.querySelectorAll('.quality-overlay-label')].map(q=>{
        const l=chips.find(c=>c.textContent.trim()===q.textContent.replace(' ','')) || chips.find(c=>c.textContent===q.textContent);
        return {label:q.textContent,quality:Object.fromEntries(props.map(p=>[p,getComputedStyle(q)[p]])),language:Object.fromEntries(props.map(p=>[p,getComputedStyle(l)[p]])),background:getComputedStyle(l).backgroundColor,border:getComputedStyle(l).borderColor,color:getComputedStyle(l).color};
      });
    });
    expect(pairs).toHaveLength(4);
    for(const pair of pairs) expect(pair.language,JSON.stringify(pair)).toEqual(pair.quality);
    if(preset.document) {
      expect(pairs[0].color).toBe('rgb(255, 0, 0)');
      expect(pairs[1].color).toBe('rgb(255, 0, 0)');
      expect(pairs[3].background).toBe('rgb(102, 0, 102)');
    } else if(preset.id==='poster') {
      expect(pairs.every(p=>p.background==='rgb(80, 30, 30)' && p.color==='rgb(255, 255, 255)')).toBe(true);
    } else {
      const colours = await page.evaluate(row => {
        const n=document.createElement('span');document.body.append(n);
        const normalise=value=>{n.style.color=value;return getComputedStyle(n).color;};
        const result={background:normalise(row.background),border:normalise(row.border)};n.remove();return result;
      },preset);
      expect(pairs.every(p=>p.background===colours.background && p.border===colours.border),JSON.stringify(pairs)).toBe(true);
    }
  });
}

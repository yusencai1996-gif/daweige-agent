// A-07 验证:启动应用截图,检查欢迎页标题与消息角色名
const electron = require('playwright')._electron;

(async () => {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env },
  });
  const window = await app.firstWindow();
  await window.waitForTimeout(2000);

  const bodyText = await window.textContent('body');
  const welcomeTitle = await window.textContent('.welcome-title').catch(() => null);
  const titleBarBrand = await window.textContent('.titlebar-brand, .brand').catch(() => null);
  console.log('welcome-title =', welcomeTitle);
  console.log('titlebar/brand =', titleBarBrand);
  console.log('body 含"小柊" =', bodyText.includes('小柊'));
  console.log('body 含"大微阁"(应只剩产品位) =', (bodyText.match(/大微阁/g) || []).length);

  await window.screenshot({ path: 'docs/design/acceptance-check/a07-welcome-check.png' });
  console.log('screenshot saved');
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });

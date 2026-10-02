// 主题切换：cookie 持久化，服务端渲染时读取并注入 <html data-theme>，
// 因此刷新无闪烁。未选择过主题时跟随系统偏好（纯 CSS media query）。
const COOKIE = 'tq_theme';
const YEAR = 31536000;

export function savedTheme() {
  return document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(light|dark)`))?.[1] || null;
}
export function systemTheme() {
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
export function effectiveTheme() {
  return savedTheme() ?? systemTheme();
}
function apply(theme) {
  // 仅手动选择过的主题写入 data-theme；跟随系统时移除，让 CSS media query 接管
  if (savedTheme()) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function paintToggle(button, theme) {
  // 图标显示"点击后将切换到"的目标模式：当前亮 → 显示月亮
  const toDark = theme === 'light';
  button.querySelector('.icon-sun').hidden = toDark;
  button.querySelector('.icon-moon').hidden = !toDark;
  const label = toDark ? '切换到深色模式' : '切换到浅色模式';
  button.title = label;
  button.setAttribute('aria-label', label);
}
export function setupThemeToggle(button) {
  if (!button) return () => effectiveTheme();
  paintToggle(button, effectiveTheme());
  button.addEventListener('click', () => {
    const next = effectiveTheme() === 'light' ? 'dark' : 'light';
    document.cookie = `${COOKIE}=${next}; Path=/; Max-Age=${YEAR}; SameSite=Lax`;
    document.documentElement.dataset.theme = next;
    paintToggle(button, next);
  });
  // 手动未选择时，系统切换即时生效
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    apply(effectiveTheme());
    paintToggle(button, effectiveTheme());
  });
  return () => effectiveTheme();
}

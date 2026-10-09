const assert = require('node:assert/strict');

// Exercise real hover/focus, including active tools in the night palette.
async function assertGlyphActions(page, buttons) {
  await page.bringToFront();
  for (const button of await buttons.all()) {
    if (!(await button.isEnabled())) continue;
    await button.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await button.hover();
    const bounds = await button.boundingBox();
    if (bounds) await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.waitForFunction(element => element?.isConnected && element.matches(':hover'), await button.elementHandle());
    // Wait for the theme's short color transition to reach its final value;
    // reading during the transition can produce a blended RGB value.
    await page.waitForFunction(element => {
      if (!element?.isConnected) return true;
      const active = element.classList.contains('active') || element.getAttribute('aria-pressed') === 'true';
      const probe = document.createElement('span');
      probe.style.color = active ? 'var(--accent)' : 'var(--hover-text)';
      element.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(element).color === expected;
    }, await button.elementHandle());
    const result = await button.evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      const css = getComputedStyle(element), probe = document.createElement('span');
      const active = element.classList.contains('active') || element.getAttribute('aria-pressed') === 'true';
      probe.style.color = active ? 'var(--accent)' : 'var(--hover-text)';
      element.append(probe); const expected = getComputedStyle(probe).color; probe.remove();
      return { background: css.backgroundColor, color: css.color, expected, icon: getComputedStyle(element.querySelector('svg')).color, hovered: element.matches(':hover') };
    });
    assert.equal(result.background, 'rgba(0, 0, 0, 0)', 'action hover has no tile');
    assert.equal(result.color, result.expected, 'active actions retain red; inactive actions use theme hover ink: ' + await button.getAttribute('aria-label') + ' (hovered=' + result.hovered + ')');
    assert.equal(result.icon, result.color, 'icon inherits the same feedback');
    await button.focus();
    assert.equal(await button.evaluate(element => getComputedStyle(element).outlineStyle), 'solid', 'keyboard focus remains visible');
  }
  await page.mouse.move(1, 1);
}
module.exports = { assertGlyphActions };

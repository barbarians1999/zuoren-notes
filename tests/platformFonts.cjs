// CSS declarations and fonts.check allow fallback; this reports glyph sources.
async function platformFonts(page, expression) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument');
    const { result } = await cdp.send('Runtime.evaluate', { expression });
    if (!result.objectId) throw new Error('Font probe did not resolve a DOM element.');
    try {
      const { nodeId } = await cdp.send('DOM.requestNode', { objectId: result.objectId });
      return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
    }
  } finally {
    await cdp.detach();
  }
}
module.exports = { platformFonts };

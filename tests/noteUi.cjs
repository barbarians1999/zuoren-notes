// Pane content stays mounted; tabs and controls now live in the shared bar.
function noteUI(page, id) {
  return page.locator(`[data-note-group="${id}"], [data-note-controls="${id}"], [data-tabs-group="${id}"]`);
}
async function focusNote(page, id) {
  await page.locator(`[data-pane-id="${id}"]`).evaluate(element => {
    (element.querySelector('.markdown-preview') || element.querySelector('.cm-content'))?.focus({ preventScroll: true });
  });
  await page.locator(`[data-note-controls="${id}"]`).waitFor();
}
async function moreAction(page, name) {
  if (name === '展开大纲' || name === '收起大纲') {
    await page.getByRole('button', { name, exact: true }).click();
    return;
  }
  await page.locator('.foreground-tab').click({ button: 'right' });
  await page.getByRole('menuitem', { name, exact: true }).click();
}
module.exports = { noteUI, focusNote, moreAction };

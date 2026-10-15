process.env.ZUOREN_UI_LOCK_PORT = process.argv[2];
require('../../scripts/native-ui-lock.cjs').acquireUiLock({ timeout: 10000 }).then(async lease => {
  console.log('acquired ' + Date.now());
  await new Promise(resolve => setTimeout(resolve, Number(process.argv[3])));
  await lease.release();
});

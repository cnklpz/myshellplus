import { connect } from "./lib.mjs";
const { browser, page } = await connect();
const out = await page.evaluate(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const hosts = await inv("host_list");
  const hid = hosts[0]?.id;
  return {
    hist: await inv("history_list", { hostId: hid, query: "", limit: 10 }),
    pred: await inv("predict_local", { hostId: hid, input: "ech" }),
    popup: document.querySelectorAll(".predict").length,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();

import { connect, shot } from "./lib.mjs";
const { browser, page, errors } = await connect();
console.log("url", page.url());
await page.waitForTimeout(1500);
await shot(page, "00-start");
console.log("errors", errors);
await browser.close();

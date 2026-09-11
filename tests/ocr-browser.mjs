import { chromium } from "playwright-core";
import assert from "assert/strict";

const exe =
  process.env.BROWSER_PATH ||
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const base = process.env.OCR_BASE_URL || "http://127.0.0.1:3199";
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (/Content Security Policy/i.test(m.text())) errors.push(m.text());
});
const wf = (fn, arg, opts = {}) =>
  page.waitForFunction(fn, arg, { timeout: 150000, ...opts });
const norm = (s) => s.replace(/\s+/g, " ").trim();
const plate = async (n, small) =>
  page.evaluate(
    ({ n, small }) => {
      const c = document.createElement("canvas");
      c.width = 600;
      c.height = 220;
      const x = c.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, 600, 220);
      x.fillStyle = "#000";
      x.font = "bold 96px Arial";
      x.textBaseline = "alphabetic";
      x.fillText(n, 45, 145);
      if (small) {
        x.font = "24px Arial";
        x.fillText("PERU", 270, 45);
      }
      return c.toDataURL("image/png");
    },
    { n, small },
  );
const upload = async (dataUrl) => {
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  await page.setInputFiles("[data-plate-photo]", {
    name: "plate.png",
    mimeType: "image/png",
    buffer: buf,
  });
};
const status = () =>
  page
    .$eval("[data-photo-status]", (el) => el.textContent.trim())
    .catch(() => "");

try {
  await page.goto(base + "/", { waitUntil: "load" });
  await page.$eval("#booking-form", (el) => el.removeAttribute("inert"));

  // Real OCR engine tests (no mocks)
  for (const p of ["BPP-530", "BEO-391", "B0X-697"]) {
    await upload(await plate(p, true));
    await wf(() => {
      const v = document.querySelector(".ocr-manual")?.value || "";
      const btn = document.querySelector("[data-act=crop]");
      return v.trim() !== "" && btn && !btn.disabled;
    });
    if (p === "B0X-697") {
      const optionValues = await page.$$eval(".ocr-candidates option", (els) =>
        els.map((el) => el.value),
      );
      assert.ok(
        optionValues.includes("B0X697"),
        `expected ocr-candidates to include B0X697, got ${JSON.stringify(optionValues)}`,
      );
      await page.selectOption(".ocr-candidates", "B0X697");
      const manual = await page.$eval(".ocr-manual", (el) => el.value);
      assert.equal(manual, "B0X697", `manual mismatch for ${p}`);
    } else {
      const val = norm(await page.$eval(".ocr-manual", (el) => el.value));
      assert.equal(
        val.replace("-", ""),
        p.replace("-", ""),
        `OCR mismatch for ${p}`,
      );
    }
    assert.equal(
      await page.$eval("input[name=plate]", (el) => el.value),
      "",
      "original input must stay empty",
    );
  }

  // Invalid file: 16MB
  const big = Buffer.alloc(16 * 1024 * 1024, 1);
  await page.setInputFiles("[data-plate-photo]", {
    name: "big.bin",
    mimeType: "image/png",
    buffer: big,
  });
  await wf(() =>
    document
      .querySelector("[data-photo-status]")
      ?.textContent.includes("No se pudo cargar"),
  );
  assert.match(
    await page.$eval("[data-photo-status]", (el) => el.textContent.trim()),
    /No se pudo cargar/,
  );
  assert.ok(
    await page.$eval(".ocr-panel", (el) => el.hidden),
    "panel must hide after invalid file",
  );

  // Cancel during new upload
  await upload(await plate("BPP-530", true));
  await wf(
    () =>
      !document.querySelector("[data-act=cancel]")?.hidden &&
      document.querySelector("[data-act=cancel]")?.offsetParent !== null,
  );
  await page.click("[data-act=cancel]");
  await page.waitForTimeout(500);
  assert.equal(await status(), "Cancelado.");

  // Crop run on already loaded good fixture
  await upload(await plate("BPP-530", true));
  await wf(
    () =>
      document.querySelector(".ocr-manual")?.value.trim() !== "" &&
      !document.querySelector("[data-act=crop]")?.disabled,
  );
  // Set crop ranges
  await page.evaluate(() => {
    const ranges = {
      '[data-crop="x"]': "0",
      '[data-crop="y"]': "30",
      '[data-crop="w"]': "100",
      '[data-crop="h"]': "60",
    };
    for (const [selector, value] of Object.entries(ranges)) {
      const el = document.querySelector(selector);
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.click("[data-act=crop]");
  await wf(() => document.querySelector(".ocr-manual")?.value.trim() !== "");
  assert.equal(
    norm(await page.$eval(".ocr-manual", (el) => el.value)),
    "BPP530",
  );

  // Mobile overflow
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  assert.equal(overflow, false, "horizontal overflow on mobile");

  if (errors.length) throw new Error("Browser errors: " + errors.join(" | "));
  console.log("OCR browser tests passed");
} catch (e) {
  console.error("Status:", await status());
  console.error("Errors:", errors);
  throw e;
} finally {
  await browser.close();
}

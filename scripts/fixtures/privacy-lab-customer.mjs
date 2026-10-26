// lab:shopify-privacy's planted customer (phase I, H9a; ADR-0041 item 31): the synthetic
// customer the customers/* phases name, its details unique to the run so a whole-database
// search finds only what the lab planted, the texts phase I plants in each form, and the
// private markers O1 (no log line) and I4 (no refusal) search for. Every form a planted text
// carries has a marker (H9A-R6): the email whole and by its local part (the obfuscated
// "(at) ... (dot)" form keeps only the local part), and the phone spaced as planted, without
// its country code, and as bare digits. tests/customer-screen.test.mjs checks that every
// planted text holds a marker and is refused by the screen. Synthetic values only.
import { randomBytes } from "node:crypto";

/** The run's customer: an email, a phone in the UK drama range, a street and a customer GID. */
export function plantedCustomer(random = randomBytes) {
  const customerEmail = "lab-customer-" + random(6).toString("hex") + "@example.test";
  const obfuscatedEmail = customerEmail.replace("@", " (at) ").replace(/\.test$/, " (dot) test");
  const screenPhoneDigits = "447700900" + String(100 + (random(2).readUInt16BE() % 900));
  const screenPhone = "+44 7700 900" + screenPhoneDigits.slice(-3);
  const screenStreet = "Quill" + random(4).toString("hex") + " Street";
  const screenGidNumber = "7" + String(random(6).readUIntBE(0, 6)).padStart(12, "0").slice(-12);
  return Object.freeze({
    customerEmail,
    obfuscatedEmail,
    screenPhoneDigits,
    screenPhone,
    screenStreet,
    screenGidNumber,
    markers: Object.freeze([
      customerEmail,
      customerEmail.split("@")[0],
      obfuscatedEmail,
      screenPhone,
      screenPhone.slice(4),
      screenPhoneDigits,
      screenStreet,
      screenGidNumber,
    ]),
  });
}

/**
 * The texts phase I plants: I1's notebook.write texts, knowledge.propose texts and source, and
 * I4's posts, each naming the customer in one form.
 */
export function phaseITexts(c) {
  return Object.freeze({
    notebook: Object.freeze([
      `Reach her at ${c.customerEmail} about the parcel.`,
      `Her mobile is ${c.screenPhone}.`,
    ]),
    returnsText: `Customers post returns to 12 ${c.screenStreet}.`,
    giftSource: `gid://shopify/Customer/${c.screenGidNumber}`,
    repliesText: `Write to ${c.obfuscatedEmail}.`,
    posts: Object.freeze([
      `Refund ${c.customerEmail} for order #1042`,
      `She called from ${c.screenPhone}`,
      `Ship it to 12 ${c.screenStreet}`,
      `https://admin.shopify.com/store/lab-store/customers/${c.screenGidNumber}`,
    ]),
  });
}

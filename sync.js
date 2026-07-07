// sync.js
// Pulls all rows from a Notion database and pushes them into a Framer CMS collection
// using Framer's Server API (framer-api npm package).
//
// Required environment variables (set as GitHub Actions secrets):
//   NOTION_TOKEN          - Notion internal integration token
//   NOTION_DATABASE_ID    - The Notion database ID to read from
//   FRAMER_API_KEY        - API key from Framer > Site Settings > API
//   FRAMER_PROJECT_URL    - e.g. https://framer.com/projects/Sites--aabbccddeeff
//   FRAMER_COLLECTION_NAME- The exact name of the CMS collection to sync into

import { Client } from "@notionhq/client";
import { connect } from "framer-api";

const {
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  FRAMER_API_KEY,
  FRAMER_PROJECT_URL,
  FRAMER_COLLECTION_NAME,
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("NOTION_DATABASE_ID", NOTION_DATABASE_ID);
requireEnv("FRAMER_API_KEY", FRAMER_API_KEY);
requireEnv("FRAMER_PROJECT_URL", FRAMER_PROJECT_URL);
requireEnv("FRAMER_COLLECTION_NAME", FRAMER_COLLECTION_NAME);

// --- Helpers to read Notion property values -------------------------------

function getPlainText(richTextArray = []) {
  return richTextArray.map((t) => t.plain_text).join("");
}

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Converts Notion rich text (with bold/italic/links/etc.) into basic HTML,
// so formatting survives into Framer's formattedText fields (like "Content").
// Plain, unformatted text passes through unchanged aside from HTML-escaping.
function richTextToHtml(richTextArray = []) {
  return richTextArray
    .map((t) => {
      let text = escapeHtml(t.plain_text).replace(/\n/g, "<br/>");
      const a = t.annotations || {};
      if (a.code) text = `<code>${text}</code>`;
      if (a.bold) text = `<strong>${text}</strong>`;
      if (a.italic) text = `<em>${text}</em>`;
      if (a.strikethrough) text = `<s>${text}</s>`;
      if (a.underline) text = `<u>${text}</u>`;
      if (t.href) text = `<a href="${t.href}">${text}</a>`;
      return text;
    })
    .join("");
}

// Converts a single Notion property value into a plain JS value based on its type.
function readNotionProperty(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case "title":
      return getPlainText(prop.title);
    case "rich_text":
      // Uses HTML-preserving conversion for any short rich_text properties.
      // NOTE: the long "Content" field is NOT read from here — it comes from
      // the Notion page body instead. See fetchPageBodyHtml() below.
      return richTextToHtml(prop.rich_text);
    case "number":
      return prop.number;
    case "checkbox":
      return prop.checkbox;
    case "select":
      return prop.select ? prop.select.name : null;
    case "multi_select":
      return (prop.multi_select || []).map((o) => o.name);
    case "date":
      return prop.date ? prop.date.start : null;
    case "url":
      return prop.url;
    case "email":
      return prop.email;
    case "files":
      return prop.files?.[0]?.file?.url || prop.files?.[0]?.external?.url || null;
    case "people":
      return (prop.people || []).map((p) => p.name).filter(Boolean);
    default:
      return null;
  }
}

// Turns a Notion page into a flat { propertyName: value } object.
function flattenNotionPage(page) {
  const flat = {};
  for (const [key, prop] of Object.entries(page.properties)) {
    flat[key] = readNotionProperty(prop);
  }
  return flat;
}

// --- Page body (blocks) -> HTML, for the "Content" field -------------------
//
// The long formatted text (headings, tables, lists) lives in the Notion PAGE
// BODY of each row, not in a database property. This section fetches that
// body's blocks and converts them into HTML, matching what the Notion CMS
// plugin does internally.

async function fetchBlockChildren(notion, blockId) {
  const blocks = [];
  let cursor = undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  // Recursively fetch children for any block that has nested content
  // (list items, table rows, toggles, quotes, callouts, etc.).
  for (const block of blocks) {
    if (block.has_children) {
      block._children = await fetchBlockChildren(notion, block.id);
    }
  }

  return blocks;
}

function blockRichTextToHtml(block) {
  const richText = block[block.type]?.rich_text || [];
  return richTextToHtml(richText);
}

// Converts a flat array of (possibly nested) Notion blocks into an HTML string.
// Consecutive list items are grouped into a single <ul>/<ol>.
function blocksToHtml(blocks = []) {
  let html = "";
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    if (block.type === "bulleted_list_item") {
      let items = "";
      while (i < blocks.length && blocks[i].type === "bulleted_list_item") {
        items += `<li>${blockRichTextToHtml(blocks[i])}${
          blocks[i]._children ? blocksToHtml(blocks[i]._children) : ""
        }</li>`;
        i++;
      }
      html += `<ul>${items}</ul>`;
      continue;
    }

    if (block.type === "numbered_list_item") {
      let items = "";
      while (i < blocks.length && blocks[i].type === "numbered_list_item") {
        items += `<li>${blockRichTextToHtml(blocks[i])}${
          blocks[i]._children ? blocksToHtml(blocks[i]._children) : ""
        }</li>`;
        i++;
      }
      html += `<ol>${items}</ol>`;
      continue;
    }

    switch (block.type) {
      case "paragraph":
        html += `<p>${blockRichTextToHtml(block)}</p>`;
        break;
      case "heading_1":
        html += `<h1>${blockRichTextToHtml(block)}</h1>`;
        break;
      case "heading_2":
        html += `<h2>${blockRichTextToHtml(block)}</h2>`;
        break;
      case "heading_3":
        html += `<h3>${blockRichTextToHtml(block)}</h3>`;
        break;
      case "quote":
        html += `<blockquote>${blockRichTextToHtml(block)}</blockquote>`;
        break;
      case "callout":
        html += `<blockquote>${blockRichTextToHtml(block)}</blockquote>`;
        break;
      case "code": {
        const code = escapeHtml(getPlainText(block.code?.rich_text));
        html += `<pre><code>${code}</code></pre>`;
        break;
      }
      case "divider":
        html += `<hr/>`;
        break;
      case "image": {
        const src = block.image?.file?.url || block.image?.external?.url;
        if (src) html += `<img src="${src}" />`;
        break;
      }
      case "table": {
        const rows = (block._children || [])
          .map((row) => {
            const cells = (row.table_row?.cells || [])
              .map((cell) => `<td>${richTextToHtml(cell)}</td>`)
              .join("");
            return `<tr>${cells}</tr>`;
          })
          .join("");
        html += `<table><tbody>${rows}</tbody></table>`;
        break;
      }
      default:
        // Unsupported block types (embeds, files, etc.) are skipped rather
        // than breaking the sync.
        break;
    }
    i++;
  }

  return html;
}

async function fetchPageBodyHtml(notion, pageId) {
  const blocks = await fetchBlockChildren(notion, pageId);
  return blocksToHtml(blocks);
}

function slugify(text) {
  return String(text || "untitled")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

// --- Main ------------------------------------------------------------------

async function fetchAllNotionRows(notion, databaseId) {
  const rows = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    rows.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return rows;
}

async function main() {
  console.log("Starting Notion -> Framer sync...");

  // 1. Read everything from Notion
  const notion = new Client({ auth: NOTION_TOKEN });
  const pages = await fetchAllNotionRows(notion, NOTION_DATABASE_ID);
  console.log(`Fetched ${pages.length} rows from Notion.`);

  const rows = [];
  for (const page of pages) {
    const contentHtml = await fetchPageBodyHtml(notion, page.id);
    rows.push({
      notionId: page.id,
      ...flattenNotionPage(page),
      Content: contentHtml, // overrides any "Content" property with the page body
    });
  }
  console.log(`Converted page bodies for ${rows.length} rows into HTML.`);

  // 2. Connect to Framer's Server API
  const framer = await connect(FRAMER_PROJECT_URL, FRAMER_API_KEY);

  try {
    const collections = await framer.getCollections();
    const collection = collections.find(
      (c) => c.name === FRAMER_COLLECTION_NAME
    );

    if (!collection) {
      const names = collections.map((c) => c.name).join(", ");
      throw new Error(
        `Collection "${FRAMER_COLLECTION_NAME}" not found. Available collections: ${names}`
      );
    }

    const fields = await collection.getFields();
    // Build a quick lookup: field name -> full field object (id, type, cases, etc.)
    const fieldByName = {};
    for (const field of fields) {
      fieldByName[field.name] = field;
    }

    console.log(
      `Target collection "${collection.name}" has fields: ${Object.keys(
        fieldByName
      ).join(", ")}`
    );

    // Converts one raw Notion value into the shape Framer's addItems() expects,
    // based on the destination field's actual type (string, number, boolean,
    // enum, date, formattedText, image, link, color).
    function toFieldDataEntry(field, rawValue, notionPropertyName) {
      switch (field.type) {
        case "string":
          return { type: "string", value: String(rawValue) };
        case "number": {
          const num = typeof rawValue === "number" ? rawValue : parseFloat(rawValue);
          if (Number.isNaN(num)) return null;
          return { type: "number", value: num };
        }
        case "boolean":
          return { type: "boolean", value: Boolean(rawValue) };
        case "date": {
          const d = new Date(rawValue);
          if (Number.isNaN(d.getTime())) return null;
          return { type: "date", value: d.toISOString() };
        }
        case "link":
          return { type: "link", value: String(rawValue) };
        case "image":
          return { type: "image", value: String(rawValue) };
        case "color":
          return { type: "color", value: String(rawValue) };
        case "formattedText":
          return notionPropertyName === "Content"
            ? { type: "formattedText", value: rawValue, contentType: "html" }
            : { type: "formattedText", value: String(rawValue) };
        case "enum": {
          // Enum fields need the matching CASE ID, not the raw label text.
          const label = String(rawValue).trim().toLowerCase();
          const match = (field.cases || []).find(
            (c) => c.name.trim().toLowerCase() === label
          );
          if (!match) {
            console.warn(
              `  (skipping "${field.name}": no matching option for "${rawValue}")`
            );
            return null;
          }
          return { type: "enum", value: match.id };
        }
        default:
          console.warn(
            `  (skipping "${field.name}": unsupported field type "${field.type}")`
          );
          return null;
      }
    }

    // Fetch existing items so we can UPDATE matches (by slug) and CREATE the rest.
    // For unmanaged collections, providing an "id" means "update that existing
    // item" — so new items must NOT include an id (Framer assigns one).
    const existingItems = await collection.getItems();
    const existingIdBySlug = {};
    for (const item of existingItems) {
      existingIdBySlug[item.slug] = item.id;
    }
    console.log(`Collection currently has ${existingItems.length} items.`);

    // 3. Map Notion rows -> Framer CMS items
    // EDIT PROPERTY_TO_FIELD_MAP (below) to match your actual Notion property
    // names and your actual Framer field names.
    const items = rows.map((row) => {
      const fieldData = {};

      for (const [notionPropertyName, fieldName] of Object.entries(
        PROPERTY_TO_FIELD_MAP
      )) {
        const field = fieldByName[fieldName];
        if (!field) continue; // field doesn't exist in this collection, skip
        const rawValue = row[notionPropertyName];
        if (rawValue === undefined || rawValue === null || rawValue === "") continue;

        const entry = toFieldDataEntry(field, rawValue, notionPropertyName);
        if (entry) fieldData[field.id] = entry;
      }

      const slug = slugify(row[TITLE_PROPERTY_NAME] || row.notionId);
      const existingId = existingIdBySlug[slug];

      return {
        ...(existingId ? { id: existingId } : {}), // id only when updating
        slug,
        fieldData,
      };
    });

    // 4. Push into Framer
    await collection.addItems(items);
    console.log(`Synced ${items.length} items into "${collection.name}".`);
  } finally {
    await framer.disconnect();
  }
}

// ---------------------------------------------------------------------------
// CONFIGURE THESE TWO CONSTANTS FOR YOUR NOTION DATABASE / FRAMER COLLECTION
// ---------------------------------------------------------------------------

// The exact Notion property name that holds the title (used for the slug).
const TITLE_PROPERTY_NAME = "Name";

// Map of "Notion property name" -> "Framer CMS field name".
// Add/remove rows here to match your actual database + collection.
const PROPERTY_TO_FIELD_MAP = {
  Name: "Name",
  Content: "Content", // populated from the Notion PAGE BODY, see fetchPageBodyHtml()
  Status: "Status",
  Stock: "Stock",
  "Price/kg(SAR)": "Price/kg(SAR)",
  Image: "Image",
  Origin: "Origin",
  District: "District",
  Process: "Process",
  Variety: "Variety",
  Score: "Score",
  "Weight Unit": "Weight Unit",
  "Notes & Description": "Notes & Description",
  "Product link (shopify)": "Product link (shopify)",
  SKU: "SKU",
};
// "Image:alt" in your CSV export is auto-generated by Framer and isn't
// something to map from Notion — left out on purpose, as you said.

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});

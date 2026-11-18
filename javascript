import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Admin Client (bypasses RLS for ingestion & link caching)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INSTACART_BASE_URL =
  process.env.INSTACART_API_BASE_URL || "https://connect.dev.instacart.tools";

/**
 * Helper: Maps flyer units to Instacart IDP supported units of measurement.
 * Unsupported units cause quantity matching to fail in IDP.
 */
function normalizeInstacartUnit(rawUnit = "each") {
  const u = rawUnit.toLowerCase().trim();
  if (["lb", "lbs", "pound", "pounds", "per lb"].includes(u)) return "pound";
  if (["oz", "ounce", "ounces"].includes(u)) return "ounce";
  if (["fl oz", "fluid ounce"].includes(u)) return "fluid_ounce";
  if (["gal", "gallon"].includes(u)) return "gallon";
  if (["pkg", "package", "pack", "bag", "box", "clamshell"].includes(u)) return "package";
  if (["bunch", "bunches"].includes(u)) return "bunch";
  return "each";
}

/**
 * 1. GET /api/flyers
 * Fetch merged weekly flyers for a given ZIP code, optional store slug, and search query.
 */
app.get("/api/flyers", async (req, res) => {
  try {
    const { zip = "93720", store = "all", category = "All", q = "" } = req.query;

    let query = supabase
      .from("flyer_items")
      .select(`
        id,
        name,
        brand,
        category,
        unit_label,
        sale_price,
        regular_price,
        promo_tag,
        upc,
        image_url,
        stores!inner ( id, slug, name, badge_color ),
        flyer_cycles!inner ( id, zip_code, valid_from, valid_to, is_active )
      `)
      .eq("flyer_cycles.zip_code", zip)
      .eq("flyer_cycles.is_active", true);

    if (store !== "all") {
      query = query.eq("stores.slug", store);
    }
    if (category !== "All") {
      query = query.eq("category", category);
    }
    if (q.trim()) {
      query = query.textSearch("search_vector", q.trim(), { type: "websearch" });
    }

    const { data, error } = await query.limit(150);
    if (error) throw error;

    res.json({ zip, count: data.length, items: data });
  } catch (err) {
    console.error("Error fetching flyers:", err);
    res.status(500).json({ error: "Failed to fetch weekly circulars" });
  }
});

/**
 * 2. POST /api/flyers/ingest
 * Triggered every Wednesday by Supabase Cron / GitHub Actions to upsert weekly circulars.
 * Expected payload:
 * {
 *   "zip_code": "93720",
 *   "valid_from": "2026-11-18",
 *   "valid_to": "2026-11-24",
 *   "store": { "slug": "savemart", "name": "Save Mart" },
 *   "items": [ { "external_item_id": "sm-101", "name": "Ribeye Steak", "sale_price": 7.99, ... } ]
 * }
 */
app.post("/api/flyers/ingest", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.INGEST_CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized ingestion request" });
    }

    const { zip_code, valid_from, valid_to, store, items } = req.body;
    if (!zip_code || !store?.slug || !Array.isArray(items)) {
      return res.status(400).json({ error: "Missing zip_code, store, or items array" });
    }

    // 1. Upsert Store
    const { data: storeRow, error: storeErr } = await supabase
      .from("stores")
      .upsert(
        {
          slug: store.slug,
          name: store.name,
          badge_color: store.badge_color || "bg-emerald-100 text-emerald-800"
        },
        { onConflict: "slug" }
      )
      .select()
      .single();
    if (storeErr) throw storeErr;

    // 2. Deactivate older flyer cycles for this store + ZIP
    await supabase
      .from("flyer_cycles")
      .update({ is_active: false })
      .eq("store_id", storeRow.id)
      .eq("zip_code", zip_code)
      .lt("valid_from", valid_from);

    // 3. Upsert Current Flyer Cycle
    const { data: cycleRow, error: cycleErr } = await supabase
      .from("flyer_cycles")
      .upsert(
        {
          store_id: storeRow.id,
          zip_code,
          valid_from,
          valid_to,
          is_active: true
        },
        { onConflict: "store_id,zip_code,valid_from" }
      )
      .select()
      .single();
    if (cycleErr) throw cycleErr;

    // 4. Upsert Flyer Items
    const formattedItems = items.map((item, idx) => ({
      flyer_cycle_id: cycleRow.id,
      store_id: storeRow.id,
      external_item_id: item.external_item_id || `${store.slug}-${idx}`,
      name: item.name,
      brand: item.brand || null,
      category: item.category || "Pantry",
      unit_label: item.unit_label || "each",
      idp_unit: normalizeInstacartUnit(item.idp_unit || item.unit_label),
      idp_quantity: item.idp_quantity || 1,
      sale_price: item.sale_price,
      regular_price: item.regular_price || null,
      promo_tag: item.promo_tag || "Weekly Special",
      upc: item.upc || null,
      image_url: item.image_url || null
    }));

    const { error: itemsErr } = await supabase
      .from("flyer_items")
      .upsert(formattedItems, { onConflict: "flyer_cycle_id,external_item_id" });
    if (itemsErr) throw itemsErr;

    res.json({
      status: "ingested",
      store: storeRow.name,
      zip_code,
      items_upserted: formattedItems.length
    });
  } catch (err) {
    console.error("Ingestion error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3. POST /api/checkout/instacart
 * Groups selected flyer items by store and generates real Instacart IDP shoppable list URLs.
 * Body: { "zip_code": "93720", "selections": [ { "item_id": "uuid", "quantity": 2 } ] }
 */
app.post("/api/checkout/instacart", async (req, res) => {
  try {
    const { zip_code = "93720", selections = [] } = req.body;
    if (!selections.length) {
      return res.status(400).json({ error: "No items selected" });
    }

    const itemIds = selections.map((s) => s.item_id);
    const qtyMap = Object.fromEntries(selections.map((s) => [s.item_id, s.quantity || 1]));

    // Fetch full item details from Supabase
    const { data: dbItems, error } = await supabase
      .from("flyer_items")
      .select("*, stores(id, slug, name)")
      .in("id", itemIds);

    if (error) throw error;

    // Group selected items by store (Instacart fulfillment runs per retailer)
    const groupedByStore = {};
    for (const item of dbItems) {
      const slug = item.stores.slug;
      if (!groupedByStore[slug]) {
        groupedByStore[slug] = { store: item.stores, items: [] };
      }
      groupedByStore[slug].items.push({
        ...item,
        requestedQty: qtyMap[item.id] || 1
      });
    }

    const storeLinks = [];

    for (const [slug, group] of Object.entries(groupedByStore)) {
      // Deterministic hash for URL caching (avoids redundant IDP API calls)
      const canonical = group.items
        .map((i) => `${i.id}:${i.requestedQty}`)
        .sort()
        .join("|");
      const basketHash = crypto
        .createHash("sha256")
        .update(`${slug}:${zip_code}:${canonical}`)
        .digest("hex");

      // Check Supabase cache first
      const { data: cached } = await supabase
        .from("shoppable_links")
        .select("instacart_url, expires_at")
        .eq("basket_hash", basketHash)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (cached?.instacart_url) {
        storeLinks.push({
          store_name: group.store.name,
          store_slug: slug,
          item_count: group.items.length,
          instacart_url: cached.instacart_url,
          cached: true
        });
        continue;
      }

      // Build Instacart Developer Platform payload: POST /idp/v1/products/products_link
      const idpPayload = {
        title: `${group.store.name} Weekly Flyer Deals`,
        link_type: "shopping_list",
        expires_in: 7, // Matches 7-day weekly circular cycle
        instructions: [
          `Weekly circular deals curated for ZIP ${zip_code}. Select ${group.store.name} on Instacart to apply store pricing.`
        ],
        line_items: group.items.map((item) => {
          const lineItem = {
            name: item.name,
            display_text: `${item.name} — Flyer Price $${Number(item.sale_price).toFixed(2)} (${item.unit_label})`,
            line_item_measurements: [
              {
                quantity: Number(item.idp_quantity) * Number(item.requestedQty),
                unit: normalizeInstacartUnit(item.idp_unit)
              }
            ]
          };
          if (item.brand) {
            lineItem.filters = { brand_filters: [item.brand] };
          }
          if (item.upc) {
            lineItem.upcs = [item.upc];
          }
          return lineItem;
        }),
        landing_page_configuration: {
          partner_linkback_url: `${process.env.APP_BASE_URL}/?zip=${zip_code}`,
          enable_pantry_items: true
        }
      };

      const idpResponse = await fetch(`${INSTACART_BASE_URL}/idp/v1/products/products_link`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.INSTACART_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(idpPayload)
      });

      if (!idpResponse.ok) {
        const errBody = await idpResponse.text();
        throw new Error(`Instacart IDP Error (${idpResponse.status}): ${errBody}`);
      }

      const idpData = await idpResponse.json();
      const shoppableUrl = idpData.products_link_url;

      // Cache the generated Instacart URL in Supabase
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabase.from("shoppable_links").upsert({
        basket_hash: basketHash,
        store_id: group.store.id,
        zip_code,
        instacart_url: shoppableUrl,
        payload_snapshot: idpPayload,
        expires_at: expiresAt
      });

      storeLinks.push({
        store_name: group.store.name,
        store_slug: slug,
        item_count: group.items.length,
        instacart_url: shoppableUrl,
        cached: false
      });
    }

    res.json({
      zip_code,
      total_stores: storeLinks.length,
      checkout_links: storeLinks
    });
  } catch (err) {
    console.error("Instacart checkout handoff error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`FlyerCart API running on http://localhost:${PORT}`);
});

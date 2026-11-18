-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Grocery Retailers (Stores)
CREATE TABLE public.stores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT UNIQUE NOT NULL,                -- e.g., 'savemart', 'vons', 'smartfinal'
  name TEXT NOT NULL,                       -- e.g., 'Save Mart'
  instacart_retailer_key TEXT,              -- Optional Instacart retailer slug/ID
  badge_color TEXT DEFAULT 'bg-slate-100 text-slate-800',
  logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Weekly Flyer Cycles (Scoped by Store & ZIP Code)
CREATE TABLE public.flyer_cycles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,                   -- e.g., '93720'
  external_flyer_id TEXT,                   -- ID from aggregator feed (e.g., Flipp/circular ID)
  valid_from DATE NOT NULL,
  valid_to DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, zip_code, valid_from)
);

CREATE INDEX idx_flyer_cycles_zip_active ON public.flyer_cycles (zip_code, is_active, valid_to);

-- 3. Flyer Deals / Circular Line Items
CREATE TABLE public.flyer_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flyer_cycle_id UUID NOT NULL REFERENCES public.flyer_cycles(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  external_item_id TEXT,                    -- Deduplication key from feed
  name TEXT NOT NULL,                       -- e.g., 'USDA Choice Ribeye Steak'
  brand TEXT,                               -- Optional brand filter for Instacart IDP
  category TEXT NOT NULL DEFAULT 'Pantry',  -- 'Produce', 'Meat & Seafood', 'Dairy & Eggs', etc.
  unit_label TEXT NOT NULL DEFAULT 'each',  -- Display unit: 'per lb', '16 oz clamshell'
  idp_unit TEXT NOT NULL DEFAULT 'each',    -- Instacart supported unit: 'each', 'pound', 'ounce', 'package'
  idp_quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  sale_price NUMERIC(10, 2) NOT NULL,
  regular_price NUMERIC(10, 2),
  promo_tag TEXT,                           -- e.g., 'Front Page Deal', 'Digital Coupon'
  upc TEXT,                                 -- Optional UPC for exact catalog matching
  image_url TEXT,
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(category, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flyer_cycle_id, external_item_id)
);

CREATE INDEX idx_flyer_items_search ON public.flyer_items USING GIN (search_vector);
CREATE INDEX idx_flyer_items_store ON public.flyer_items (store_id, category);

-- 4. Cached Instacart Shoppable Links (Recommended by Instacart IDP Best Practices)
CREATE TABLE public.shoppable_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  basket_hash TEXT UNIQUE NOT NULL,         -- SHA-256 hash of sorted store_id + item IDs + quantities
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,
  instacart_url TEXT NOT NULL,              -- Returned products_link_url from Instacart IDP
  payload_snapshot JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flyer_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flyer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shoppable_links ENABLE ROW LEVEL SECURITY;

-- Public Read Policies for Active Flyers
CREATE POLICY "Public read stores" ON public.stores FOR SELECT USING (true);
CREATE POLICY "Public read active cycles" ON public.flyer_cycles FOR SELECT USING (is_active = true);
CREATE POLICY "Public read flyer items" ON public.flyer_items FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.flyer_cycles fc
    WHERE fc.id = flyer_items.flyer_cycle_id AND fc.is_active = true
  )
);

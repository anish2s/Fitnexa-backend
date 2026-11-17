/**
 * Money is integer paise everywhere (₹999.00 = 99900). Never floats in storage or responses.
 */
export const TAX_MODES = ['inclusive', 'exclusive', 'none'] as const;
export type TaxMode = (typeof TAX_MODES)[number];
/** GST slabs. Gym and fitness services are 18%. */
export const GST_RATES = [0, 5, 12, 18, 28] as const;

export interface PriceBreakdown {
  /** Taxable value after discount. */
  basePaise: number;
  gstPaise: number;
  /** What the member pays. */
  totalPaise: number;
}

/**
 * Splits a price into taxable value and GST.
 *  - exclusive: GST is added on top of the price.
 *  - inclusive: the price already contains GST; base = price × 100 / (100 + rate).
 *  - none: no GST (also used by gyms without a GSTIN).
 * A discount comes off the price before tax. Rounding is to the nearest paisa.
 */
export function priceBreakdown(
  pricePaise: number,
  mode: TaxMode,
  ratePercent: number,
  discountPaise = 0,
): PriceBreakdown {
  if (!Number.isInteger(pricePaise) || pricePaise < 0)
    throw new Error('price must be integer paise');
  if (!Number.isInteger(discountPaise) || discountPaise < 0 || discountPaise > pricePaise) {
    throw new Error('discount must be integer paise within the price');
  }
  const net = pricePaise - discountPaise;
  if (mode === 'none' || ratePercent === 0) return { basePaise: net, gstPaise: 0, totalPaise: net };
  if (mode === 'exclusive') {
    const gst = Math.round((net * ratePercent) / 100);
    return { basePaise: net, gstPaise: gst, totalPaise: net + gst };
  }
  const base = Math.round((net * 100) / (100 + ratePercent));
  return { basePaise: base, gstPaise: net - base, totalPaise: net };
}

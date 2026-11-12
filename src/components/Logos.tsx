import Image from "next/image";
import { assetInfo, VENUE } from "@/lib/present";
import type { VenueId } from "@/lib/venues/types";

/** Coin logo, falling back to a coloured letter tile for assets without a logo file. */
export function AssetIcon({ asset, size = 40 }: { asset: string; size?: number }) {
  const a = assetInfo(asset);
  if (a.logo)
    return <Image className="asset-logo" src={a.logo} alt={a.name} width={size} height={size} unoptimized />;
  return (
    <span className="asset-icon" style={{ background: a.color, width: size, height: size, fontSize: size * 0.5 }} aria-hidden>
      {a.symbol}
    </span>
  );
}

/** Round venue logo on the venue's own tile colour. */
export function VenueLogo({ venue, size = 20 }: { venue: VenueId; size?: number }) {
  const v = VENUE[venue];
  return (
    <span className="venue-logo" style={{ width: size, height: size, background: v.tile }} title={v.name}>
      <Image src={v.logo} alt={v.name} width={size} height={size} unoptimized />
    </span>
  );
}

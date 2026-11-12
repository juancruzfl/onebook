import Link from "next/link";
import { Logo } from "@/components/Logo";

const REPO = "https://github.com/juancruzfl/onebook";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Logo />
          <p className="muted small">
            One order across prediction markets. onebook only combines markets that pay out the same way.
          </p>
        </div>
        <nav className="footer-cols" aria-label="Footer">
          <div>
            <h4>Product</h4>
            <Link href="/">Markets</Link>
            <Link href="/sign-test">Chain Signatures test</Link>
          </div>
          <div>
            <h4>Resources</h4>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={`${REPO}/blob/main/docs/ARCHITECTURE.md`} target="_blank" rel="noreferrer">
              Architecture
            </a>
            <a href="https://docs.near.org/chain-abstraction/chain-signatures" target="_blank" rel="noreferrer">
              NEAR Chain Signatures
            </a>
          </div>
          <div>
            <h4>Data from</h4>
            <a href="https://polymarket.com" target="_blank" rel="noreferrer">
              Polymarket
            </a>
            <a href="https://kalshi.com" target="_blank" rel="noreferrer">
              Kalshi
            </a>
            <a href="https://hyperliquid.xyz" target="_blank" rel="noreferrer">
              Hyperliquid
            </a>
          </div>
        </nav>
      </div>
      <div className="footer-bottom">
        <span>Built at NEAR HACKATHON 2026 · MIT licensed</span>
        <span>
          Not financial advice. Prices come from public venue APIs. Trading is not enabled; it will not be offered
          where a venue restricts access.
        </span>
      </div>
    </footer>
  );
}

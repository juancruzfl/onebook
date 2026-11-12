import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="brand" aria-label="onebook home">
      <svg className="brand-mark" width="24" height="24" viewBox="0 0 24 24" aria-hidden>
        <circle cx="9" cy="12" r="7" fill="var(--accent)" opacity="0.55" />
        <circle cx="15" cy="12" r="7" fill="var(--accent)" />
      </svg>
      onebook
    </Link>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono, Sora } from "next/font/google";
import "./globals.css";
import { Footer } from "@/components/Footer";
import { WalletProvider } from "@/components/WalletProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** Wordmark only (see .brand in globals.css). */
const brand = Sora({
  variable: "--font-brand",
  subsets: ["latin"],
  weight: ["700"],
});

export const metadata: Metadata = {
  title: "onebook",
  description: "Prediction-market router that matches markets on how they pay out and settles through NEAR Intents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} ${brand.variable}`}>
        <WalletProvider>
          <div className="page">
            <div className="page-main">{children}</div>
            <Footer />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SKALE BITE x402 Test",
  description: "Test x402 payments on SKALE BITE using @relai-fi/x402 SDK",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

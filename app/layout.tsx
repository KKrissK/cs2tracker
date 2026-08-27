import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
  title: 'Stackline — CS2 Premier Match Intelligence',
  description: 'Filter CS2 Premier matches by the players who were present and compare lineup-adjusted performance.',
  openGraph: {
    title: 'Stackline — CS2 Premier Match Intelligence',
    description: 'Filter Premier matches by lineup and compare match-adjusted CS2 performance.',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Stackline — CS2 Premier Match Intelligence',
    description: 'Filter Premier matches by lineup and compare match-adjusted CS2 performance.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "پنل مدیریت Silver Love — فروشگاه نقره",
  description:
    "سیستم فروش و مدیریت اختصاصی فروشگاه نقره Silver Love — پنل مدیریت، ربات تلگرام و دستیار هوش مصنوعی فروشنده",
  icons: {
    icon: "/logo.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <head>
        <style>{`
          @font-face {
            font-family: 'Vazirmatn';
            src: url('/fonts/Vazirmatn-Regular.woff2') format('woff2');
            font-weight: 400;
            font-style: normal;
            font-display: swap;
          }
          @font-face {
            font-family: 'Vazirmatn';
            src: url('/fonts/Vazirmatn-Medium.woff2') format('woff2');
            font-weight: 500;
            font-style: normal;
            font-display: swap;
          }
          @font-face {
            font-family: 'Vazirmatn';
            src: url('/fonts/Vazirmatn-SemiBold.woff2') format('woff2');
            font-weight: 600;
            font-style: normal;
            font-display: swap;
          }
          @font-face {
            font-family: 'Vazirmatn';
            src: url('/fonts/Vazirmatn-Bold.woff2') format('woff2');
            font-weight: 700;
            font-style: normal;
            font-display: swap;
          }
        `}</style>
      </head>
      <body className="antialiased bg-background text-foreground font-sans">
        {children}
        <Toaster />
        <Sonner position="bottom-left" richColors closeButton />
      </body>
    </html>
  );
}

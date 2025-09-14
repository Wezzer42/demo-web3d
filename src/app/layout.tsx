export const metadata = { title: "3D Gallery", description: "Mini 3D showroom" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: 16 }}>{children}</div>
      </body>
    </html>
  );
}

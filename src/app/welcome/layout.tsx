/** Setup has the whole screen: no menu, nothing else to open until it is finished. */
export default function WelcomeLayout({ children }: LayoutProps<'/welcome'>) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto min-h-screen max-w-3xl p-4 outline-none md:p-10">
      {children}
    </main>
  );
}

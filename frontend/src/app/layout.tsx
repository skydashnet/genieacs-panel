import './globals.css'
import Sidebar from '@/components/sidebar'
import Navbar from '@/components/navbar'
import { ThemeProvider } from '@/contexts/theme-context'
import { AuthProvider } from '@/contexts/auth-context'

export const metadata = {
  title: 'GenieACS Panel - Network Management',
  description: 'Modern network device management panel for GenieACS',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="id">
      <body className="bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200">
        <AuthProvider>
          <ThemeProvider>
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              <div className="flex-1 overflow-y-auto md:ml-0">
                <Navbar />
                <main className="min-h-full md:pt-16 pt-16">
                  {children}
                </main>
              </div>
            </div>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
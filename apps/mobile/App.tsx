import { StatusBar } from "expo-status-bar"
import { useEffect, useState } from "react"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"

import type { MobileSession, ProjectListItem } from "./src/api/client"
import { BooksScreen } from "./src/screens/BooksScreen"
import { ChaptersScreen } from "./src/screens/ChaptersScreen"
import { DiscussScreen } from "./src/screens/DiscussScreen"
import { LoginScreen } from "./src/screens/LoginScreen"
import { clearSession, loadSession, saveSession } from "./src/storage/session"

type Route =
  | { name: "login" }
  | { name: "books" }
  | { name: "discuss"; project: ProjectListItem }
  | { name: "chapters"; project: ProjectListItem }

export default function App() {
  const [session, setSession] = useState<MobileSession | undefined>()
  const [booting, setBooting] = useState(true)
  const [route, setRoute] = useState<Route>({ name: "login" })

  useEffect(() => {
    void (async () => {
      const saved = await loadSession()
      if (saved !== undefined) {
        setSession(saved)
        setRoute({ name: "books" })
      }
      setBooting(false)
    })()
  }, [])

  if (booting) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: "#0f1419" }} />
      </SafeAreaProvider>
    )
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#0f1419" }}>
        <StatusBar style="light" />
        {route.name === "login" || session === undefined ? (
          <LoginScreen
            initial={session}
            onConnected={(next) => {
              void saveSession(next)
              setSession(next)
              setRoute({ name: "books" })
            }}
          />
        ) : null}
        {route.name === "books" && session !== undefined ? (
          <BooksScreen
            session={session}
            onOpenBook={(project) => setRoute({ name: "discuss", project })}
            onLogout={() => {
              void clearSession()
              setSession(undefined)
              setRoute({ name: "login" })
            }}
          />
        ) : null}
        {route.name === "discuss" && session !== undefined ? (
          <DiscussScreen
            session={session}
            project={route.project}
            onBack={() => setRoute({ name: "books" })}
            onOpenChapters={() => setRoute({ name: "chapters", project: route.project })}
          />
        ) : null}
        {route.name === "chapters" && session !== undefined ? (
          <ChaptersScreen
            session={session}
            project={route.project}
            onBack={() => setRoute({ name: "discuss", project: route.project })}
          />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

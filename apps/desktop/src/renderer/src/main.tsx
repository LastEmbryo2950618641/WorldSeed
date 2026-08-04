import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { App } from "./app/App.js"
import "./styles/global.css"

const root = document.getElementById("root")
if (root === null) throw new Error("Renderer root is missing")

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)

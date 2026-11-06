import { useEffect } from 'react'
import Dashboard from './Dashboard.jsx'
import Lockdown from './Lockdown.jsx'

// DA5H is a dashboard with modules. The first module is Lockdown; the path
// selects the module while both share the same bundle and chrome.
export default function App() {
  const path = window.location.pathname.replace(/\/+$/, '')
  const lockdown = path === '/lockdown'

  useEffect(() => {
    document.title = lockdown ? 'DA5H ⋅ Lockdown' : 'DA5H'
  }, [lockdown])

  return lockdown ? <Lockdown /> : <Dashboard />
}

import { startTransition, useEffect, useState } from 'react'
import './App.css'

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'
async function fetchTasks(search, filter) {
  const params = new URLSearchParams({ ...(search && { search }), ...(filter !== 'all' && { status: filter }) })
  const response = await fetch(`${API}/tasks?${params}`)
  return response.json()
}

function App() {
  const [tasks, setTasks] = useState([])
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState({ title: '', description: '' })
  const [editing, setEditing] = useState(null)
  const [message, setMessage] = useState('Loading workspace...')

  async function load() {
    const data = await fetchTasks(search, filter)
    setTasks(data.tasks)
    setMessage(`${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'} in view`)
  }

  useEffect(() => {
    let active = true
    fetchTasks(search, filter).then((data) => { if (active) startTransition(() => { setTasks(data.tasks); setMessage(`${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'} in view`) }) }).catch(() => { if (active) setMessage('Backend unavailable. Start the API and try again.') })
    return () => { active = false }
  }, [filter, search])

  async function saveTask(event) {
    event.preventDefault()
    const url = editing ? `${API}/tasks/${editing.id}` : `${API}/tasks`
    const response = await fetch(url, { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', ...(editing && { 'If-Match': String(editing.version) }) }, body: JSON.stringify(draft) })
    if (!response.ok) { const data = await response.json(); setMessage(data.error || 'Could not save task'); return }
    setDraft({ title: '', description: '' }); setEditing(null); await load()
  }

  async function syncNow() {
    setMessage('Syncing with GitHub...')
    const response = await fetch(`${API}/sync`, { method: 'POST' })
    const data = await response.json()
    setMessage(data.ok ? 'Sync complete' : data.error)
    await load()
  }

  async function resolve(task, choice) {
    await fetch(`${API}/tasks/${task.id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) })
    await load()
  }

  return <main className="shell">
    <header className="topbar"><div><p className="kicker">FIELD NOTES / TASKS</p><h1>Keep work in step.</h1><p className="lede">A clear view of what is local, what is on GitHub, and what needs your call.</p></div><button className="sync-button" onClick={syncNow} title="Run bidirectional sync">↻ Sync now</button></header>
    <section className="metrics"><div><span>VISIBLE TASKS</span><strong>{tasks.length}</strong></div><div><span>NEEDS ATTENTION</span><strong>{tasks.filter((task) => ['conflict', 'error'].includes(task.syncStatus)).length}</strong></div><div><span>LAST SIGNAL</span><strong className="signal">{message}</strong></div></section>
    <section className="workspace"><aside><div className="new-task"><p className="eyebrow">{editing ? 'EDIT TASK' : 'NEW TASK'}</p><form onSubmit={saveTask}><input aria-label="Task title" required placeholder="Task title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /><textarea aria-label="Task description" placeholder="Add context..." value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /><button className="primary" type="submit">{editing ? 'Save changes' : 'Add to queue'}</button>{editing && <button className="quiet" type="button" onClick={() => { setEditing(null); setDraft({ title: '', description: '' }) }}>Cancel</button>}</form></div><div className="policy"><span className="dot amber" />Conflict policy<strong>Manual choice</strong><p>Local edits stay pending until you choose which version should win.</p></div></aside>
      <div className="list"><div className="list-head"><div><p className="eyebrow">WORK QUEUE</p><h2>All tasks</h2></div><input aria-label="Search tasks" className="search" placeholder="Search tasks" value={search} onChange={(event) => setSearch(event.target.value)} /></div><nav className="filters">{['all', 'synced', 'pending', 'conflict', 'error'].map((item) => <button className={filter === item ? 'selected' : ''} key={item} onClick={() => setFilter(item)}>{item}</button>)}</nav><div className="task-list">{tasks.length === 0 ? <div className="empty">Nothing here yet. Add a task or adjust the filter.</div> : tasks.map((task) => <article className={`task ${task.syncStatus}`} key={task.id}><div className="task-main"><div className="task-title"><span className={`status ${task.syncStatus}`} /> <h3>{task.title}</h3></div><p>{task.description || 'No description'}</p>{task.providerUrl && <a href={task.providerUrl} target="_blank" rel="noreferrer">Open on GitHub ↗</a>}</div><div className="task-meta"><span className={`badge ${task.syncStatus}`}>{task.syncStatus}</span>{task.error && <small>{task.error}</small>}{task.syncStatus === 'conflict' ? <div className="conflict-actions"><button onClick={() => resolve(task, 'local')}>Keep local</button><button onClick={() => resolve(task, 'remote')}>Keep GitHub</button></div> : <button className="edit" onClick={() => { setEditing(task); setDraft({ title: task.title, description: task.description }) }}>Edit</button>}</div></article>)}</div></div>
    </section>
  </main>
}

export default App

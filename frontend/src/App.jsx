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
  const [message, setMessage] = useState('Loading tasks...')

  async function load() {
    const data = await fetchTasks(search, filter)
    setTasks(data.tasks)
    setMessage(`${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'} found`)
  }

  useEffect(() => {
    let active = true
    fetchTasks(search, filter).then((data) => { if (active) startTransition(() => { setTasks(data.tasks); setMessage(`${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'} found`) }) }).catch(() => { if (active) setMessage('Could not load tasks. Is the backend running?') })
    return () => { active = false }
  }, [filter, search])

  async function saveTask(event) {
    event.preventDefault()
    const url = editing ? `${API}/tasks/${editing.id}` : `${API}/tasks`
    const response = await fetch(url, { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', ...(editing && { 'If-Match': String(editing.version) }) }, body: JSON.stringify(draft) })
    if (!response.ok) { const data = await response.json(); setMessage(data.error || 'The task could not be saved.'); return }
    setDraft({ title: '', description: '' }); setEditing(null); await load()
  }

  async function syncNow() {
    setMessage('Syncing with GitHub...')
    const response = await fetch(`${API}/sync`, { method: 'POST' })
    const data = await response.json()
    setMessage(data.ok ? 'Sync finished.' : data.error)
    await load()
  }

  async function resolve(task, choice) {
    await fetch(`${API}/tasks/${task.id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) })
    await load()
  }

  return <main className="shell">
    <header className="topbar"><div><p className="kicker">TASKS</p><h1>Tasks in one place.</h1><p className="lede">Create and update tasks here or in GitHub. This page shows which version is current.</p></div><button className="sync-button" onClick={syncNow} title="Run bidirectional sync">↻ Sync now</button></header>
    <section className="metrics"><div><span>TASKS</span><strong>{tasks.length}</strong></div><div><span>NEEDS REVIEW</span><strong>{tasks.filter((task) => ['conflict', 'error'].includes(task.syncStatus)).length}</strong></div><div><span>STATUS</span><strong className="signal">{message}</strong></div></section>
    <section className="workspace"><aside><div className="new-task"><p className="eyebrow">{editing ? 'EDIT TASK' : 'ADD A TASK'}</p><form onSubmit={saveTask}><input aria-label="Task title" required placeholder="Task title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /><textarea aria-label="Task description" placeholder="Description (optional)" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /><button className="primary" type="submit">{editing ? 'Save changes' : 'Add task'}</button>{editing && <button className="quiet" type="button" onClick={() => { setEditing(null); setDraft({ title: '', description: '' }) }}>Cancel</button>}</form></div><div className="policy"><span className="dot amber" />When there is a conflict<strong>You choose the version</strong><p>Local changes stay here until you decide whether to keep them or use the GitHub version.</p></div></aside>
      <div className="list"><div className="list-head"><div><p className="eyebrow">TASK LIST</p><h2>All tasks</h2></div><input aria-label="Search tasks" className="search" placeholder="Search" value={search} onChange={(event) => setSearch(event.target.value)} /></div><nav className="filters">{['all', 'synced', 'pending', 'conflict', 'error'].map((item) => <button className={filter === item ? 'selected' : ''} key={item} onClick={() => setFilter(item)}>{item}</button>)}</nav><div className="task-list">{tasks.length === 0 ? <div className="empty">No tasks found. Add a task or change the filter.</div> : tasks.map((task) => <article className={`task ${task.syncStatus}`} key={task.id}><div className="task-main"><div className="task-title"><span className={`status ${task.syncStatus}`} /> <h3>{task.title}</h3></div><p>{task.description || 'No description added.'}</p>{task.providerUrl && <a href={task.providerUrl} target="_blank" rel="noreferrer">View on GitHub ↗</a>}{task.conflict && <div className="versions"><div><strong>This app</strong><span>{task.conflict.local.title}</span><small>{task.conflict.local.description || 'No description'}</small></div><div><strong>GitHub</strong><span>{task.conflict.remote.title}</span><small>{task.conflict.remote.description || 'No description'}</small></div></div>}</div><div className="task-meta"><span className={`badge ${task.syncStatus}`}>{task.syncStatus}</span>{task.error && <small>{task.error}</small>}{task.syncStatus === 'conflict' ? <div className="conflict-actions"><button onClick={() => resolve(task, 'local')}>Keep this version</button><button onClick={() => resolve(task, 'remote')}>Use GitHub version</button></div> : <button className="edit" onClick={() => { setEditing(task); setDraft({ title: task.title, description: task.description }) }}>Edit</button>}</div></article>)}</div></div>
    </section>
  </main>
}

export default App

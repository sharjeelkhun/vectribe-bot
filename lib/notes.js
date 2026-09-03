// lib/notes.js — per-user notes & task lists (persistent)
import { load, save } from './store.js';

const notes = load('notes');   // [{id, userId, text, createdAt}]
const tasks = load('tasks');   // [{id, userId, text, done, createdAt, doneAt}]

let noteId = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
let taskId = tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;

/* notes */
export function addNote(userId, text) {
  const n = { id: noteId++, userId, text, createdAt: Date.now() };
  notes.push(n);
  save('notes', notes);
  return n;
}
export function listNotes(userId) {
  return notes.filter((n) => n.userId === userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 15);
}
export function deleteNote(userId, id) {
  const i = notes.findIndex((n) => n.id === id && n.userId === userId);
  if (i === -1) return false;
  notes.splice(i, 1);
  save('notes', notes);
  return true;
}

/* tasks */
export function addTask(userId, text) {
  const t = { id: taskId++, userId, text, done: false, createdAt: Date.now(), doneAt: null };
  tasks.push(t);
  save('tasks', tasks);
  return t;
}
export function listTasks(userId) {
  return tasks
    .filter((t) => t.userId === userId)
    .sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt)
    .slice(0, 25);
}
export function completeTask(userId, id) {
  const t = tasks.find((t) => t.id === id && t.userId === userId);
  if (!t) return false;
  t.done = true;
  t.doneAt = Date.now();
  save('tasks', tasks);
  return true;
}
export function deleteTask(userId, id) {
  const i = tasks.findIndex((t) => t.id === id && t.userId === userId);
  if (i === -1) return false;
  tasks.splice(i, 1);
  save('tasks', tasks);
  return true;
}

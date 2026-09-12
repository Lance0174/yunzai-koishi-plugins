import { randomBytes } from 'node:crypto'
import { PublicError, DeliveryError } from './net'

export interface Ticket<T> {
  id: string
  owner: string
  key: string
  state: string
  created: number
  control: AbortController
  done: Promise<T>
  error: string
}
interface Pending<T> {
  ticket: Ticket<T>
  run: (signal: AbortSignal) => Promise<T>
  prepare?: (signal: AbortSignal) => Promise<unknown>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
export class Queue<T> {
  readonly tickets = new Map<string, Ticket<T>>()
  private pending: Pending<T>[] = []
  private running = new Map<string, Promise<void>>()
  private closed = false
  constructor(
    readonly concurrency: number,
    readonly capacity: number,
    readonly timeout: number,
  ) {}
  add(
    owner: string,
    key: string,
    run: (signal: AbortSignal) => Promise<T>,
    prepare?: (signal: AbortSignal) => Promise<unknown>,
  ): Ticket<T> {
    if (this.closed) throw new PublicError('插件正在停止。')
    if ([...this.tickets.values()].some((t) => t.key === key && ['queued', 'running'].includes(t.state)))
      throw new PublicError('此视频已有任务正在处理，请稍后重试。')
    if (this.pending.length + this.running.size >= this.capacity + this.concurrency)
      throw new PublicError('视频队列已满，请稍后再试。')
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const done = new Promise<T>((a, b) => {
      resolve = a
      reject = b
    })
    void done.catch(() => {})
    const ticket: Ticket<T> = {
      id: randomBytes(8).toString('hex'),
      owner,
      key,
      state: 'queued',
      created: Date.now(),
      control: new AbortController(),
      done,
      error: '',
    }
    this.tickets.set(ticket.id, ticket)
    this.pending.push({ ticket, run, prepare, resolve, reject })
    for (const [id, old] of this.tickets)
      if (this.tickets.size > 200 && !['queued', 'running'].includes(old.state)) this.tickets.delete(id)
    this.pump()
    return ticket
  }
  private pump() {
    while (!this.closed && this.running.size < this.concurrency && this.pending.length) {
      const pending = this.pending.shift()!,
        { ticket } = pending
      if (ticket.control.signal.aborted) continue
      ticket.state = 'running'
      let timer: ReturnType<typeof setTimeout> | undefined
      const work = Promise.resolve()
        .then(async () => {
          await pending.prepare?.(ticket.control.signal)
          if (ticket.control.signal.aborted) throw new PublicError('视频任务已取消。')
          timer = setTimeout(() => ticket.control.abort(), this.timeout)
          return pending.run(ticket.control.signal)
        })
        .then((value) => {
          if (ticket.control.signal.aborted) throw new PublicError('视频任务已取消或超时。')
          ticket.state = 'completed'
          pending.resolve(value)
        })
        .catch((error) => {
          ticket.state =
            error instanceof DeliveryError
              ? 'uncertain'
              : ticket.control.signal.aborted
                ? 'cancelled'
                : 'failed'
          ticket.error = error instanceof PublicError ? error.message : '视频处理失败。'
          pending.reject(new PublicError(ticket.error))
        })
        .finally(() => {
          clearTimeout(timer)
          this.running.delete(ticket.id)
          this.pump()
        })
      this.running.set(ticket.id, work)
    }
  }
  cancel(id: string, owner: string) {
    const ticket = this.tickets.get(id)
    if (!ticket || ticket.owner !== owner || !['queued', 'running'].includes(ticket.state)) return false
    ticket.control.abort()
    const index = this.pending.findIndex((p) => p.ticket === ticket)
    if (index >= 0) {
      const pending = this.pending.splice(index, 1)[0]
      ticket.state = 'cancelled'
      pending.reject(new PublicError('视频任务已取消。'))
    }
    return true
  }
  async close() {
    this.closed = true
    for (const ticket of this.tickets.values()) this.cancel(ticket.id, ticket.owner)
    await Promise.allSettled([...this.running.values()])
    this.tickets.clear()
  }
}

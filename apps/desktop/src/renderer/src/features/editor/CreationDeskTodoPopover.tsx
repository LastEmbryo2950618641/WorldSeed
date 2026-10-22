import { useLayoutEffect, useState } from "react"
import { createPortal } from "react-dom"
import { CheckCircle2, Circle, CircleDot, ListTodo, X, XCircle } from "lucide-react"
import type { SynopsisConversationTodo } from "@worldseed/contracts"

type Props = Readonly<{
  todos: readonly SynopsisConversationTodo[]
  anchorRef: React.RefObject<HTMLElement | null>
  onClose(): void
}>

type AnchorBox = Readonly<{
  top: number
  left: number
  width: number
}>

export function CreationDeskTodoPopover(props: Props): React.JSX.Element {
  const openCount = props.todos.filter((item) => item.status === "pending" || item.status === "in_progress").length
  const doneCount = props.todos.filter((item) => item.status === "completed").length
  const [box, setBox] = useState<AnchorBox | undefined>(undefined)

  useLayoutEffect(() => {
    const update = (): void => {
      const node = props.anchorRef.current
      if (node === null) return
      const rect = node.getBoundingClientRect()
      const width = Math.min(340, Math.max(240, window.innerWidth * 0.72))
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      setBox({
        top: rect.top - 8,
        left,
        width,
      })
    }
    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [props.anchorRef])

  const popover = <div
    className="creation-desk-todo-popover"
    role="dialog"
    aria-label="Todo 列表"
    data-testid="creation-desk-todo-popover"
    style={box === undefined
      ? { visibility: "hidden" }
      : {
          top: box.top,
          left: box.left,
          width: box.width,
          transform: "translateY(-100%)",
        }}
  >
    <header className="creation-desk-todo-popover-header">
      <div className="creation-desk-todo-popover-title">
        <strong>
          <ListTodo size={14} aria-hidden="true" />
          <span>Todo</span>
        </strong>
        <p>
          {props.todos.length === 0
            ? "Claude Code 风格任务清单"
            : `${String(openCount)} 进行中 · ${String(doneCount)} 已完成`}
        </p>
      </div>
      <button type="button" aria-label="关闭 Todo" onClick={props.onClose}>
        <X size={14} aria-hidden="true" />
      </button>
    </header>
    {props.todos.length === 0
      ? <p className="creation-desk-todo-empty">暂无任务。Agent 接到可执行指令后须先用 todo_write 写入本轮清单。</p>
      : <ol className="creation-desk-todo-list">
          {props.todos.map((todo) => <li
            key={todo.id}
            className={`creation-desk-todo-item status-${todo.status}`}
            data-status={todo.status}
          >
            <span className="creation-desk-todo-icon" aria-hidden="true">
              {todoStatusIcon(todo.status)}
            </span>
            <div>
              <p>{todo.content}</p>
              <small>{todoStatusLabel(todo.status)}</small>
            </div>
          </li>)}
        </ol>}
  </div>

  return createPortal(popover, document.body)
}

function todoStatusIcon(status: SynopsisConversationTodo["status"]): React.JSX.Element {
  if (status === "completed") return <CheckCircle2 size={14} />
  if (status === "in_progress") return <CircleDot size={14} />
  if (status === "cancelled") return <XCircle size={14} />
  return <Circle size={14} />
}

function todoStatusLabel(status: SynopsisConversationTodo["status"]): string {
  if (status === "completed") return "completed"
  if (status === "in_progress") return "in_progress"
  if (status === "cancelled") return "cancelled"
  return "pending"
}

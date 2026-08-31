import { Menu, type BrowserWindow } from "electron"

export function installApplicationMenu(window: BrowserWindow): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        { label: "新建书籍", accelerator: "CmdOrCtrl+Shift+N", click: () => { window.webContents.send("worldseed:command", "project.new"); } },
        { label: "打开书籍", accelerator: "CmdOrCtrl+O", click: () => { window.webContents.send("worldseed:command", "project.open"); } },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    { label: "编辑", submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" }] },
    { label: "查看", submenu: [{ role: "reload", label: "重新加载" }, { role: "toggleDevTools", label: "开发者工具" }, { type: "separator" }, { role: "togglefullscreen", label: "全屏" }] },
    { label: "推演", submenu: [{ label: "开始本轮推演", accelerator: "CmdOrCtrl+Enter", click: () => { window.webContents.send("worldseed:command", "turn.start"); } }] },
  ]))
}

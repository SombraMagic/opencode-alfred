// databases.js — OpenCode Alfred

(function () {
  const vscode = acquireVsCodeApi();

  // Estado local en el webview
  let currentState = {
    profiles: [],
    connected: false,
    databases: [],
    tables: [],
    columns: [],
    indexes: [],
    foreignKeys: [],
  };

  let selectedRows = new Set();
  let currentEditingCell = null;
  let activeTab = "datos";
  let previousTable = undefined;
  let previousPage = undefined;

  // ── Elementos del DOM ───────────────────────────────────────────────────
  const selProfile = document.getElementById("sel-profile");
  const btnConnect = document.getElementById("btn-connect");
  const dbStatusDot = document.getElementById("db-status-dot");
  const btnProfileNew = document.getElementById("btn-profile-new");
  const btnProfileEdit = document.getElementById("btn-profile-edit");
  const btnProfileDel = document.getElementById("btn-profile-del");
  const btnRefreshAll = document.getElementById("btn-refresh-all");
  const dbServerInfo = document.getElementById("db-server-info");

  const inputSearch = document.getElementById("input-search");
  const btnSearch = document.getElementById("btn-search");
  const btnCountRows = document.getElementById("btn-count-rows");

  const listDbs = document.getElementById("list-dbs");
  const btnDbCreate = document.getElementById("btn-db-create");
  const btnDbBackup = document.getElementById("btn-db-backup");
  const btnDbRefresh = document.getElementById("btn-db-refresh");

  const listTables = document.getElementById("list-tables");
  const btnTableCreate = document.getElementById("btn-table-create");
  const btnTableExport = document.getElementById("btn-table-export");
  const btnTableTruncate = document.getElementById("btn-table-truncate");
  const btnTableDrop = document.getElementById("btn-table-drop");

  const tabButtons = document.querySelectorAll(".db-tab-btn");
  const tabPanes = {
    datos: document.getElementById("tab-pane-datos"),
    estructura: document.getElementById("tab-pane-estructura"),
    consulta: document.getElementById("tab-pane-consulta"),
  };

  const btnRowInsert = document.getElementById("btn-row-insert");
  const btnRowsDelete = document.getElementById("btn-rows-delete");
  const btnToolbarExport = document.getElementById("btn-toolbar-export");
  const btnDataRefresh = document.getElementById("btn-data-refresh");
  const labelTableMetrics = document.getElementById("label-table-metrics");
  const gridHead = document.getElementById("grid-head");
  const gridBody = document.getElementById("grid-body");
  const gridEmpty = document.getElementById("grid-empty");

  const btnPagePrev = document.getElementById("btn-page-prev");
  const btnPageNext = document.getElementById("btn-page-next");
  const labelPageNum = document.getElementById("label-page-num");
  const selPageSize = document.getElementById("sel-page-size");
  const labelQueryTime = document.getElementById("label-query-time");

  const tableColsBody = document.getElementById("body-cols");
  const tableIndexesBody = document.getElementById("body-indexes");
  const tableFksBody = document.getElementById("body-fks");
  const btnTableRename = document.getElementById("btn-table-rename");
  const btnStructRefresh = document.getElementById("btn-struct-refresh");

  const sqlEditor = document.getElementById("sql-editor");
  const btnSqlRun = document.getElementById("btn-sql-run");
  const btnSqlClear = document.getElementById("btn-sql-clear");
  const consoleResults = document.getElementById("console-results");

  const footerBusy = document.getElementById("footer-busy");
  const footerBusyText = document.getElementById("footer-busy-text");
  const btnCancelOp = document.getElementById("btn-cancel-op");
  const footerNotice = document.getElementById("footer-notice");
  const footerError = document.getElementById("footer-error");
  const btnOpenBackupDir = document.getElementById("btn-open-backup-dir");

  // Modales
  const modalProfile = document.getElementById("modal-profile");
  const formProfile = document.getElementById("form-profile");
  const profId = document.getElementById("prof-id");
  const profName = document.getElementById("prof-name");
  const profHost = document.getElementById("prof-host");
  const profPort = document.getElementById("prof-port");
  const profUser = document.getElementById("prof-user");
  const profPass = document.getElementById("prof-pass");
  const profDatabase = document.getElementById("prof-database");
  const profSsl = document.getElementById("prof-ssl");
  const profSshEnabled = document.getElementById("prof-ssh-enabled");
  const profSshFields = document.getElementById("prof-ssh-fields");
  const profSshHost = document.getElementById("prof-ssh-host");
  const profSshPort = document.getElementById("prof-ssh-port");
  const profSshUser = document.getElementById("prof-ssh-user");
  const profSshAuth = document.getElementById("prof-ssh-auth");
  const profSshRowPw = document.getElementById("prof-ssh-row-pw");
  const profSshPw = document.getElementById("prof-ssh-pw");
  const profSshRowKey = document.getElementById("prof-ssh-row-key");
  const profSshKeypath = document.getElementById("prof-ssh-keypath");
  const profSshPassphrase = document.getElementById("prof-ssh-passphrase");

  const modalCreateDb = document.getElementById("modal-create-db");
  const formCreateDb = document.getElementById("form-create-db");
  const newDbName = document.getElementById("new-db-name");

  const modalCreateTable = document.getElementById("modal-create-table");
  const formCreateTable = document.getElementById("form-create-table");
  const newTblName = document.getElementById("new-tbl-name");
  const createColsList = document.getElementById("create-cols-list");
  const btnAddSpecCol = document.getElementById("btn-add-spec-col");

  const modalConfirmDestructive = document.getElementById("modal-confirm-destructive");
  const formConfirmDestructive = document.getElementById("form-confirm-destructive");
  const destructiveTitle = document.getElementById("destructive-title");
  const destructiveMsg = document.getElementById("destructive-msg");
  const destructiveExpected = document.getElementById("destructive-expected");
  const destructiveInput = document.getElementById("destructive-input");
  const btnDestructiveSubmit = document.getElementById("btn-destructive-submit");
  let onDestructiveConfirm = null;

  const modalConfirmSql = document.getElementById("modal-confirm-sql");
  const formConfirmSql = document.getElementById("form-confirm-sql");
  const sqlConfirmInput = document.getElementById("sql-confirm-input");
  const btnSqlConfirmSubmit = document.getElementById("btn-sql-confirm-submit");

  const modalInsertRow = document.getElementById("modal-insert-row");
  const formInsertRow = document.getElementById("form-insert-row");
  const insertRowFields = document.getElementById("insert-row-fields");

  const modalHexViewer = document.getElementById("modal-hex-viewer");
  const hexInfo = document.getElementById("hex-info");
  const hexDump = document.getElementById("hex-dump");

  const modalExportTable = document.getElementById("modal-export-table");
  const formExportTable = document.getElementById("form-export-table");

  const modalRenameTable = document.getElementById("modal-rename-table");
  const formRenameTable = document.getElementById("form-rename-table");
  const renameNewName = document.getElementById("rename-new-name");

  // ── Funciones de comunicación ───────────────────────────────────────────
  function sendAction(action) {
    vscode.postMessage({ type: "action", action });
  }

  // ── Renderizado de estado ───────────────────────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.type === "state" && msg.state) {
      applyState(msg.state);
    }
  });

  function applyState(next) {
    currentState = next;

    const tableChanged = currentState.currentTable !== previousTable;
    const pageChanged = currentState.data?.page !== previousPage;
    const dataDisappeared = !currentState.data;

    if (tableChanged || pageChanged || dataDisappeared) {
      selectedRows.clear();
      btnRowsDelete.disabled = true;
    }

    previousTable = currentState.currentTable;
    previousPage = currentState.data?.page;

    // Conexión y estado
    renderConnectionBar();
    renderSidebar();
    renderTabs();
    renderFooter();

    // Si había un notice de confirmación SQL, abrir modal SQL si corresponde
    if (next.notice && next.notice.includes("Escribe EJECUTAR para confirmar")) {
      openModal(modalConfirmSql);
      sqlConfirmInput.value = "";
      btnSqlConfirmSubmit.disabled = true;
      sqlConfirmInput.focus();
    }
  }

  function renderConnectionBar() {
    const connected = Boolean(currentState.connected);
    dbStatusDot.className = "db-status-dot" + (connected ? " connected" : currentState.error ? " error" : "");
    dbStatusDot.title = connected ? "Conectado" : "Desconectado";

    // Selector de perfiles
    selProfile.innerHTML = "";
    if (currentState.profiles && currentState.profiles.length > 0) {
      for (const p of currentState.profiles) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name + " (" + p.user + "@" + p.host + ":" + p.port + ")";
        if (p.id === currentState.activeProfileId) {
          opt.selected = true;
        }
        selProfile.appendChild(opt);
      }
    } else {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(Sin conexiones configuradas)";
      selProfile.appendChild(opt);
    }

    btnConnect.textContent = connected ? "DESCONECTAR" : "CONECTAR";
    btnConnect.className = "db-btn " + (connected ? "db-btn-danger" : "db-btn-primary");
    btnConnect.disabled = !currentState.profiles || currentState.profiles.length === 0;

    const hasProfile = Boolean(currentState.activeProfileId || (currentState.profiles && currentState.profiles.length > 0));
    btnProfileEdit.disabled = !hasProfile;
    btnProfileDel.disabled = !hasProfile;
    btnRefreshAll.disabled = !connected;

    dbServerInfo.textContent = currentState.serverInfo ? currentState.serverInfo : "";

    const hasTable = Boolean(connected && currentState.currentTable);
    inputSearch.disabled = !hasTable;
    btnSearch.disabled = !hasTable;
    btnCountRows.disabled = !hasTable;
    if (currentState.data?.search !== undefined && document.activeElement !== inputSearch) {
      inputSearch.value = currentState.data.search;
    }
  }

  function renderSidebar() {
    const connected = Boolean(currentState.connected);

    // BASES DE DATOS
    listDbs.innerHTML = "";
    btnDbCreate.disabled = !connected;
    btnDbBackup.disabled = !connected || !currentState.currentDb;
    btnDbRefresh.disabled = !connected;

    if (!connected) {
      const li = document.createElement("li");
      li.className = "db-empty-note";
      li.textContent = "Sin conexión";
      listDbs.appendChild(li);
    } else if (!currentState.databases || currentState.databases.length === 0) {
      const li = document.createElement("li");
      li.className = "db-empty-note";
      li.textContent = "No hay bases disponibles";
      listDbs.appendChild(li);
    } else {
      for (const db of currentState.databases) {
        const li = document.createElement("li");
        li.className = "db-list-item" + (db.name === currentState.currentDb ? " active" : "");
        li.title = db.name;

        const nameSpan = document.createElement("span");
        nameSpan.className = "db-item-name";
        nameSpan.textContent = db.name;

        const badge = document.createElement("span");
        badge.className = "db-item-badge";
        badge.textContent = String(db.tables);

        li.appendChild(nameSpan);
        li.appendChild(badge);

        li.addEventListener("click", () => {
          if (db.name !== currentState.currentDb) {
            sendAction({ type: "selectDatabase", database: db.name });
          }
        });

        listDbs.appendChild(li);
      }
    }

    // TABLAS
    listTables.innerHTML = "";
    const hasDb = Boolean(connected && currentState.currentDb);
    const hasTable = Boolean(hasDb && currentState.currentTable);

    btnTableCreate.disabled = !hasDb;
    btnTableExport.disabled = !hasTable;
    btnTableTruncate.disabled = !hasTable;
    btnTableDrop.disabled = !hasTable;

    if (!connected) {
      const li = document.createElement("li");
      li.className = "db-empty-note";
      li.textContent = "Sin conexión";
      listTables.appendChild(li);
    } else if (!currentState.currentDb) {
      const li = document.createElement("li");
      li.className = "db-empty-note";
      li.textContent = "Selecciona una base";
      listTables.appendChild(li);
    } else if (!currentState.tables || currentState.tables.length === 0) {
      const li = document.createElement("li");
      li.className = "db-empty-note";
      li.textContent = "No hay tablas en la base";
      listTables.appendChild(li);
    } else {
      for (const tbl of currentState.tables) {
        const li = document.createElement("li");
        li.className = "db-list-item" + (tbl.name === currentState.currentTable ? " active" : "");
        li.title = tbl.name + (tbl.comment ? " — " + tbl.comment : "");

        const nameSpan = document.createElement("span");
        nameSpan.className = "db-item-name";
        nameSpan.textContent = tbl.name;

        li.appendChild(nameSpan);

        if (tbl.isView) {
          const viewBadge = document.createElement("span");
          viewBadge.className = "db-item-badge db-item-badge-view";
          viewBadge.textContent = "VISTA";
          li.appendChild(viewBadge);
        } else if (tbl.rows > 0) {
          const rowsBadge = document.createElement("span");
          rowsBadge.className = "db-item-badge";
          rowsBadge.textContent = "~" + tbl.rows.toLocaleString("es-ES");
          li.appendChild(rowsBadge);
        }

        li.addEventListener("click", () => {
          if (tbl.name !== currentState.currentTable) {
            sendAction({ type: "selectTable", table: tbl.name });
          }
        });

        listTables.appendChild(li);
      }
    }
  }

  function renderTabs() {
    renderTabDatos();
    renderTabEstructura();
    renderTabConsulta();
  }

  function renderTabDatos() {
    const hasTable = Boolean(currentState.connected && currentState.currentTable);
    btnRowInsert.disabled = !hasTable;
    btnToolbarExport.disabled = !hasTable;
    btnDataRefresh.disabled = !hasTable;

    const hasSelection = selectedRows.size > 0;
    btnRowsDelete.disabled = !hasSelection;

    const data = currentState.data;
    if (!data || !hasTable) {
      gridHead.innerHTML = "";
      gridBody.innerHTML = "";
      gridEmpty.style.display = "flex";
      gridEmpty.textContent = currentState.connected
        ? "Selecciona una tabla para explorar sus datos."
        : "Conecta a un servidor MariaDB para comenzar.";
      labelTableMetrics.textContent = "—";
      btnPagePrev.disabled = true;
      btnPageNext.disabled = true;
      labelPageNum.textContent = "PÁGINA 1";
      return;
    }

    gridEmpty.style.display = "none";

    // Métricas
    const totalShown = data.rows.length;
    labelTableMetrics.textContent = `${totalShown} fila(s)${data.truncated ? " (más en servidor)" : ""}`;
    labelQueryTime.textContent = `${data.ms} ms`;
    labelPageNum.textContent = `PÁGINA ${data.page + 1}`;
    btnPagePrev.disabled = data.page <= 0;
    btnPageNext.disabled = totalShown < data.pageSize && !data.truncated;
    selPageSize.value = String(data.pageSize);

    // Cabecera de rejilla
    gridHead.innerHTML = "";
    const trHead = document.createElement("tr");

    // Checkbox selección global
    const thCheck = document.createElement("th");
    thCheck.style.width = "32px";
    thCheck.style.textAlign = "center";
    const masterCheck = document.createElement("input");
    masterCheck.type = "checkbox";
    masterCheck.title = "Seleccionar todas las filas visibles";
    masterCheck.checked = data.rows.length > 0 && selectedRows.size === data.rows.length;
    masterCheck.addEventListener("change", () => {
      selectedRows.clear();
      if (masterCheck.checked) {
        data.rows.forEach((_, idx) => selectedRows.add(idx));
      }
      renderTabDatos();
    });
    thCheck.appendChild(masterCheck);
    trHead.appendChild(thCheck);

    const identityCols = new Set(data.identity || []);

    data.columns.forEach((col) => {
      const th = document.createElement("th");
      const inner = document.createElement("div");
      inner.className = "db-col-header-inner";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = col.name;
      inner.appendChild(nameSpan);

      if (identityCols.has(col.name)) {
        const pkBadge = document.createElement("span");
        pkBadge.className = "db-col-pk-badge";
        pkBadge.textContent = "PK";
        inner.appendChild(pkBadge);
      }

      const typeSpan = document.createElement("span");
      typeSpan.className = "db-col-type";
      typeSpan.textContent = col.type;
      inner.appendChild(typeSpan);

      if (data.orderBy?.column === col.name) {
        const sortSpan = document.createElement("span");
        sortSpan.className = "db-sort-indicator";
        sortSpan.textContent = data.orderBy.dir === "desc" ? "▼" : "▲";
        inner.appendChild(sortSpan);
      }

      th.appendChild(inner);

      th.addEventListener("click", () => {
        let dir = "asc";
        if (data.orderBy?.column === col.name && data.orderBy.dir === "asc") {
          dir = "desc";
        }
        sendAction({
          type: "loadData",
          page: 0,
          search: data.search,
          orderBy: { column: col.name, dir },
          pageSize: data.pageSize,
        });
      });

      trHead.appendChild(th);
    });
    gridHead.appendChild(trHead);

    // Cuerpo de filas
    gridBody.innerHTML = "";
    data.rows.forEach((row, rowIdx) => {
      const tr = document.createElement("tr");
      if (selectedRows.has(rowIdx)) {
        tr.className = "selected";
      }

      // Checkbox fila
      const tdCheck = document.createElement("td");
      tdCheck.style.textAlign = "center";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = selectedRows.has(rowIdx);
      check.addEventListener("change", () => {
        if (check.checked) {
          selectedRows.add(rowIdx);
        } else {
          selectedRows.delete(rowIdx);
        }
        btnRowsDelete.disabled = selectedRows.size === 0;
        if (check.checked) {
          tr.className = "selected";
        } else {
          tr.className = "";
        }
      });
      tdCheck.appendChild(check);
      tr.appendChild(tdCheck);

      // Celdas
      row.forEach((cellVal, colIdx) => {
        const colDef = data.columns[colIdx];
        const td = document.createElement("td");

        renderCellContent(td, cellVal, rowIdx, colDef, row);

        tr.appendChild(td);
      });

      gridBody.appendChild(tr);
    });
  }

  function renderCellContent(td, cellVal, rowIdx, colDef, fullRow) {
    td.innerHTML = "";

    if (cellVal === null) {
      const span = document.createElement("span");
      span.className = "db-cell-null";
      span.textContent = "NULL";
      td.appendChild(span);
    } else if (typeof cellVal === "object" && "b64" in cellVal) {
      const span = document.createElement("span");
      span.className = "db-cell-binary";
      span.textContent = `‹binario ${cellVal.bytes} B›`;
      span.title = "Clic para ver en hexadecimal";
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        openHexViewer(colDef.name, cellVal);
      });
      td.appendChild(span);
      return; // Los binarios no son editables en línea
    } else {
      td.textContent = String(cellVal);
    }

    // Doble clic para edición inline si la tabla tiene identidad
    td.addEventListener("dblclick", () => {
      const identityCols = currentState.data?.identity || [];
      if (identityCols.length === 0) {
        showError("La tabla no tiene clave primaria: no se puede editar con seguridad.");
        return;
      }
      startCellEdit(td, cellVal, rowIdx, colDef, fullRow);
    });
  }

  function startCellEdit(td, initialVal, rowIdx, colDef, fullRow) {
    if (currentEditingCell) {
      cancelCellEdit();
    }
    currentEditingCell = { td, initialVal, rowIdx, colDef, fullRow };
    td.className = "db-cell-editing";
    td.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "db-inline-editor";

    const isNull = initialVal === null;
    const input = document.createElement("input");
    input.className = "db-inline-input";
    input.type = "text";
    input.value = isNull ? "" : String(initialVal);
    input.disabled = isNull;

    const nullLabel = document.createElement("label");
    nullLabel.className = "db-checkbox-label";
    nullLabel.style.fontSize = "10px";
    const nullCheck = document.createElement("input");
    nullCheck.type = "checkbox";
    nullCheck.checked = isNull;
    nullLabel.appendChild(nullCheck);
    nullLabel.appendChild(document.createTextNode("NULL"));

    nullCheck.addEventListener("change", () => {
      input.disabled = nullCheck.checked;
      if (!nullCheck.checked) {
        input.focus();
      }
    });

    const commitEdit = () => {
      const data = currentState.data;
      if (!data) return;

      const idCols = data.identity;
      const idValues = idCols.map((cName) => {
        const cIdx = data.columns.findIndex((c) => c.name === cName);
        return cIdx >= 0 ? fullRow[cIdx] : null;
      });

      const nextVal = nullCheck.checked ? null : input.value;
      currentEditingCell = null;

      sendAction({
        type: "updateCell",
        identity: { columns: idCols, values: idValues },
        column: colDef.name,
        value: nextVal,
      });
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelCellEdit();
      }
    });

    wrap.appendChild(input);
    wrap.appendChild(nullLabel);
    td.appendChild(wrap);

    if (!isNull) {
      input.focus();
      input.select();
    }
  }

  function cancelCellEdit() {
    if (!currentEditingCell) return;
    const { td, initialVal, rowIdx, colDef, fullRow } = currentEditingCell;
    currentEditingCell = null;
    td.className = "";
    renderCellContent(td, initialVal, rowIdx, colDef, fullRow);
  }

  function renderTabEstructura() {
    const hasTable = Boolean(currentState.connected && currentState.currentTable);
    btnTableRename.disabled = !hasTable;
    btnStructRefresh.disabled = !hasTable;

    // Columnas
    tableColsBody.innerHTML = "";
    if (!hasTable || !currentState.columns || currentState.columns.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "db-empty-note";
      td.textContent = hasTable ? "Cargando columnas..." : "Selecciona una tabla";
      tr.appendChild(td);
      tableColsBody.appendChild(tr);
    } else {
      for (const col of currentState.columns) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><strong>${escapeHtml(col.name)}</strong></td>
          <td><code>${escapeHtml(col.columnType || col.dataType)}</code></td>
          <td>${col.nullable ? "SÍ" : "NO"}</td>
          <td>${col.defaultValue !== null ? escapeHtml(col.defaultValue) : "<em>NULL</em>"}</td>
          <td>${col.key ? `<code>${escapeHtml(col.key)}</code>` : "—"}</td>
          <td>${col.extra ? escapeHtml(col.extra) : "—"}</td>
          <td>${col.comment ? escapeHtml(col.comment) : "—"}</td>
        `;
        tableColsBody.appendChild(tr);
      }
    }

    // Índices
    tableIndexesBody.innerHTML = "";
    if (!hasTable || !currentState.indexes || currentState.indexes.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 3;
      td.className = "db-empty-note";
      td.textContent = hasTable ? "Sin índices adicionales" : "—";
      tr.appendChild(td);
      tableIndexesBody.appendChild(tr);
    } else {
      for (const idx of currentState.indexes) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><strong>${escapeHtml(idx.name)}</strong></td>
          <td>${idx.unique ? "SÍ" : "NO"}</td>
          <td>${idx.columns.map((c) => `<code>${escapeHtml(c)}</code>`).join(", ")}</td>
        `;
        tableIndexesBody.appendChild(tr);
      }
    }

    // Claves foráneas
    tableFksBody.innerHTML = "";
    if (!hasTable || !currentState.foreignKeys || currentState.foreignKeys.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "db-empty-note";
      td.textContent = hasTable ? "Sin claves foráneas" : "—";
      tr.appendChild(td);
      tableFksBody.appendChild(tr);
    } else {
      for (const fk of currentState.foreignKeys) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><strong>${escapeHtml(fk.name)}</strong></td>
          <td><code>${escapeHtml(fk.column)}</code></td>
          <td>${escapeHtml(fk.refTable)}</td>
          <td><code>${escapeHtml(fk.refColumn)}</code></td>
          <td>${escapeHtml(fk.onDelete)}</td>
          <td>${escapeHtml(fk.onUpdate)}</td>
        `;
        tableFksBody.appendChild(tr);
      }
    }
  }

  function renderTabConsulta() {
    const c = currentState.console;
    if (!c) {
      return;
    }

    consoleResults.innerHTML = "";

    // Si hubo error en el console
    if (c.error) {
      const errBox = document.createElement("div");
      errBox.className = "db-console-error-box";
      errBox.textContent = `Error en sentencia #${c.error.index + 1}:\n${c.error.message}`;
      consoleResults.appendChild(errBox);
    }

    if (c.results && c.results.length > 0) {
      c.results.forEach((item, idx) => {
        const entry = document.createElement("div");
        entry.className = "db-console-entry";

        const head = document.createElement("div");
        head.className = "db-console-entry-head";

        const sqlSpan = document.createElement("span");
        sqlSpan.className = "db-console-sql-label";
        sqlSpan.textContent = `#${idx + 1}: ${item.statement}`;
        sqlSpan.title = item.statement;

        const metaSpan = document.createElement("span");
        metaSpan.className = "db-console-entry-meta";
        const parts = [`${item.result.ms} ms`];
        if (item.result.affected > 0) {
          parts.push(`${item.result.affected} filas afectadas`);
        }
        if (item.result.rows.length > 0) {
          parts.push(`${item.result.rows.length} filas obtenidas`);
        }
        if (item.result.warnings > 0) {
          parts.push(`${item.result.warnings} aviso(s)`);
        }
        metaSpan.textContent = parts.join(" · ");

        head.appendChild(sqlSpan);
        head.appendChild(metaSpan);
        entry.appendChild(head);

        // Si hay filas devueltas, pintar tabla
        if (item.result.columns.length > 0 && item.result.rows.length > 0) {
          const scrollWrap = document.createElement("div");
          scrollWrap.style.overflow = "auto";
          scrollWrap.style.maxHeight = "240px";

          const tbl = document.createElement("table");
          tbl.className = "db-grid";

          const thead = document.createElement("thead");
          const trH = document.createElement("tr");
          item.result.columns.forEach((col) => {
            const th = document.createElement("th");
            th.textContent = col.name;
            trH.appendChild(th);
          });
          thead.appendChild(trH);
          tbl.appendChild(thead);

          const tbody = document.createElement("tbody");
          item.result.rows.forEach((row) => {
            const trB = document.createElement("tr");
            row.forEach((cellVal) => {
              const tdB = document.createElement("td");
              if (cellVal === null) {
                const s = document.createElement("span");
                s.className = "db-cell-null";
                s.textContent = "NULL";
                tdB.appendChild(s);
              } else if (typeof cellVal === "object" && "b64" in cellVal) {
                tdB.textContent = `‹binario ${cellVal.bytes} B›`;
              } else {
                tdB.textContent = String(cellVal);
              }
              trB.appendChild(tdB);
            });
            tbody.appendChild(trB);
          });
          tbl.appendChild(tbody);
          scrollWrap.appendChild(tbl);
          entry.appendChild(scrollWrap);
        }

        consoleResults.appendChild(entry);
      });
    } else if (!c.error) {
      consoleResults.innerHTML = '<div class="db-console-placeholder">La consulta se completó sin devolver filas.</div>';
    }
  }

  function renderFooter() {
    if (currentState.busy) {
      footerBusy.className = "db-status-busy";
      footerBusyText.textContent = currentState.busy;
    } else {
      footerBusy.className = "db-status-busy hidden";
    }

    footerNotice.textContent = currentState.notice ? currentState.notice : "";
    footerError.textContent = currentState.error ? currentState.error : "";

    if (currentState.backupDir) {
      btnOpenBackupDir.style.display = "inline";
    } else {
      btnOpenBackupDir.style.display = "none";
    }
  }

  function showError(msg) {
    footerError.textContent = msg;
    footerNotice.textContent = "";
  }

  // ── Navegación por pestañas ─────────────────────────────────────────────
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      if (tab) {
        setTab(tab);
      }
    });
  });

  function setTab(tab) {
    activeTab = tab;
    tabButtons.forEach((b) => {
      if (b.getAttribute("data-tab") === tab) {
        b.className = "db-tab-btn active";
      } else {
        b.className = "db-tab-btn";
      }
    });

    Object.keys(tabPanes).forEach((key) => {
      if (key === tab) {
        tabPanes[key].className = "db-pane active";
      } else {
        tabPanes[key].className = "db-pane";
      }
    });
  }

  // ── Eventos de la barra superior ────────────────────────────────────────
  selProfile.addEventListener("change", () => {
    const id = selProfile.value;
    if (id) {
      currentState.activeProfileId = id;
    }
  });

  btnConnect.addEventListener("click", () => {
    if (currentState.connected) {
      sendAction({ type: "disconnect" });
    } else {
      const id = selProfile.value;
      if (id) {
        sendAction({ type: "connect", id });
      }
    }
  });

  btnRefreshAll.addEventListener("click", () => {
    sendAction({ type: "refreshDatabases" });
  });

  btnSearch.addEventListener("click", () => {
    sendAction({
      type: "loadData",
      page: 0,
      search: inputSearch.value.trim(),
      pageSize: Number(selPageSize.value) || 100,
    });
  });

  inputSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      btnSearch.click();
    }
  });

  btnCountRows.addEventListener("click", () => {
    sendAction({ type: "countTable" });
  });

  // ── Acciones de Bases de Datos ──────────────────────────────────────────
  btnDbRefresh.addEventListener("click", () => {
    sendAction({ type: "refreshDatabases" });
  });

  btnDbCreate.addEventListener("click", () => {
    openModal(modalCreateDb);
    newDbName.value = "";
    newDbName.focus();
  });

  formCreateDb.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = newDbName.value.trim();
    if (name) {
      closeModal(modalCreateDb);
      sendAction({ type: "createDatabase", name });
    }
  });

  btnDbBackup.addEventListener("click", () => {
    sendAction({ type: "backupDatabase" });
  });

  // ── Acciones de Tablas ──────────────────────────────────────────────────
  btnTableCreate.addEventListener("click", () => {
    openModal(modalCreateTable);
    newTblName.value = "";
    createColsList.innerHTML = "";
    addSpecColRow("id", "INT", "", false, null, true, true, "Clave primaria");
    addSpecColRow("nombre", "VARCHAR", "120", false, null, false, false, "");
    newTblName.focus();
  });

  btnAddSpecCol.addEventListener("click", () => {
    addSpecColRow("", "VARCHAR", "120", true, null, false, false, "");
  });

  function addSpecColRow(name, type, len, nullable, defVal, autoInc, pk, comment) {
    const row = document.createElement("div");
    row.className = "db-spec-col-row";

    row.innerHTML = `
      <input type="text" class="db-input flex-2 col-name" placeholder="nombre_col" value="${escapeHtml(name)}" required />
      <select class="db-select flex-1 col-type">
        ${[
          "INT", "BIGINT", "SMALLINT", "TINYINT", "VARCHAR", "CHAR", "TEXT",
          "LONGTEXT", "DATETIME", "TIMESTAMP", "DATE", "DECIMAL", "DOUBLE", "BOOLEAN", "JSON", "BLOB"
        ].map((t) => `<option value="${t}" ${t === type ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <input type="text" class="db-input flex-1 col-len" placeholder="longitud" value="${escapeHtml(len)}" style="max-width: 60px;" />
      <label class="db-checkbox-label" title="Permite nulos"><input type="checkbox" class="col-null" ${nullable ? "checked" : ""} /><span>NULL</span></label>
      <label class="db-checkbox-label" title="Clave primaria"><input type="checkbox" class="col-pk" ${pk ? "checked" : ""} /><span>PK</span></label>
      <label class="db-checkbox-label" title="Auto incremento"><input type="checkbox" class="col-ai" ${autoInc ? "checked" : ""} /><span>AI</span></label>
      <button type="button" class="db-icon-btn db-icon-btn-danger btn-del-col" title="Quitar columna">✕</button>
    `;

    row.querySelector(".btn-del-col").addEventListener("click", () => {
      row.remove();
    });

    createColsList.appendChild(row);
  }

  formCreateTable.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = newTblName.value.trim();
    if (!name) return;

    const rows = createColsList.querySelectorAll(".db-spec-col-row");
    if (rows.length === 0) {
      showError("Añade al menos una columna a la tabla.");
      return;
    }

    const columns = [];
    rows.forEach((r) => {
      const colName = r.querySelector(".col-name").value.trim();
      const colType = r.querySelector(".col-type").value;
      const colLen = r.querySelector(".col-len").value.trim();
      const colNull = r.querySelector(".col-null").checked;
      const colPk = r.querySelector(".col-pk").checked;
      const colAi = r.querySelector(".col-ai").checked;

      if (colName) {
        columns.push({
          name: colName,
          type: colType,
          length: colLen || undefined,
          nullable: colNull,
          defaultValue: null,
          autoIncrement: colAi,
          primaryKey: colPk,
        });
      }
    });

    if (columns.length === 0) return;

    closeModal(modalCreateTable);
    sendAction({ type: "createTable", spec: { name, columns } });
  });

  btnTableTruncate.addEventListener("click", () => {
    if (!currentState.currentTable) return;
    const table = currentState.currentTable;
    openDestructiveConfirm(
      "VACIAR TABLA",
      `¿Seguro que deseas vaciar todos los registros de "${table}"? Esta acción no se puede deshacer.`,
      table,
      () => {
        sendAction({ type: "truncateTable", table, confirm: table });
      }
    );
  });

  btnTableDrop.addEventListener("click", () => {
    if (!currentState.currentTable) return;
    const table = currentState.currentTable;
    openDestructiveConfirm(
      "ELIMINAR TABLA",
      `¿Seguro que deseas destruir la tabla "${table}" y todos sus datos?`,
      table,
      () => {
        sendAction({ type: "dropTable", table, confirm: table });
      }
    );
  });

  btnTableExport.addEventListener("click", () => {
    if (!currentState.currentTable) return;
    openModal(modalExportTable);
  });

  btnToolbarExport.addEventListener("click", () => {
    btnTableExport.click();
  });

  formExportTable.addEventListener("submit", (e) => {
    e.preventDefault();
    const selectedRadio = formExportTable.querySelector('input[name="export-format"]:checked');
    const format = selectedRadio ? selectedRadio.value : "csv";
    closeModal(modalExportTable);
    sendAction({ type: "exportTable", format });
  });

  // ── Renombrar tabla ─────────────────────────────────────────────────────
  btnTableRename.addEventListener("click", () => {
    if (!currentState.currentTable) return;
    renameNewName.value = currentState.currentTable;
    openModal(modalRenameTable);
    renameNewName.focus();
    renameNewName.select();
  });

  formRenameTable.addEventListener("submit", (e) => {
    e.preventDefault();
    const to = renameNewName.value.trim();
    if (to && to !== currentState.currentTable) {
      closeModal(modalRenameTable);
      sendAction({ type: "renameTable", from: currentState.currentTable, to });
    }
  });

  btnStructRefresh.addEventListener("click", () => {
    sendAction({ type: "refreshStructure" });
  });

  // ── Datos: Inserción y borrado ──────────────────────────────────────────
  btnRowInsert.addEventListener("click", () => {
    if (!currentState.columns || currentState.columns.length === 0) return;
    insertRowFields.innerHTML = "";

    currentState.columns.forEach((col) => {
      const row = document.createElement("div");
      row.className = "db-insert-field-row";

      const isAi = col.extra && col.extra.toLowerCase().includes("auto_increment");
      const isNull = col.nullable && col.defaultValue === null;

      row.innerHTML = `
        <span class="db-insert-field-name" title="${escapeHtml(col.name)}">${escapeHtml(col.name)}</span>
        <span class="db-insert-field-type">${escapeHtml(col.dataType)}</span>
        <input class="db-input db-insert-field-input" data-col="${escapeHtml(col.name)}" type="text" placeholder="${isAi ? '(Auto incremental)' : ''}" ${isAi ? 'disabled' : ''} />
        <label class="db-checkbox-label" style="font-size:10px;">
          <input type="checkbox" class="insert-null-check" ${isNull && !isAi ? 'checked' : ''} ${isAi ? 'disabled' : ''} />
          <span>NULL</span>
        </label>
      `;

      const input = row.querySelector(".db-insert-field-input");
      const nullCheck = row.querySelector(".insert-null-check");

      if (isNull && !isAi) {
        input.disabled = true;
      }

      nullCheck.addEventListener("change", () => {
        input.disabled = nullCheck.checked;
        if (!nullCheck.checked) {
          input.focus();
        }
      });

      insertRowFields.appendChild(row);
    });

    openModal(modalInsertRow);
  });

  formInsertRow.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = {};
    const fieldRows = insertRowFields.querySelectorAll(".db-insert-field-row");

    fieldRows.forEach((r) => {
      const input = r.querySelector(".db-insert-field-input");
      const colName = input.getAttribute("data-col");
      const nullCheck = r.querySelector(".insert-null-check");

      if (nullCheck.checked) {
        values[colName] = null;
      } else if (!input.disabled) {
        const c = currentState.columns?.find((x) => x.name === colName);
        if (input.value !== "" || !c || c.defaultValue === null) {
          values[colName] = input.value;
        }
      }
    });

    closeModal(modalInsertRow);
    sendAction({ type: "insertRow", values });
  });

  btnRowsDelete.addEventListener("click", () => {
    const data = currentState.data;
    if (!data || selectedRows.size === 0) return;

    const idCols = data.identity;
    if (!idCols || idCols.length === 0) {
      showError("La tabla no tiene clave primaria: no se pueden borrar filas con seguridad.");
      return;
    }

    const rowsToDelete = [];
    selectedRows.forEach((rowIdx) => {
      const row = data.rows[rowIdx];
      if (row) {
        const idVals = idCols.map((cName) => {
          const cIdx = data.columns.findIndex((c) => c.name === cName);
          return cIdx >= 0 ? row[cIdx] : null;
        });
        rowsToDelete.push(idVals);
      }
    });

    openDestructiveConfirm(
      "BORRAR FILAS SELECCIONADAS",
      `¿Seguro que deseas eliminar las ${rowsToDelete.length} filas seleccionadas?`,
      "BORRAR",
      () => {
        selectedRows.clear();
        sendAction({
          type: "deleteRows",
          identity: { columns: idCols, rows: rowsToDelete },
        });
      }
    );
  });

  btnDataRefresh.addEventListener("click", () => {
    sendAction({
      type: "loadData",
      page: currentState.data?.page ?? 0,
      search: currentState.data?.search ?? "",
      orderBy: currentState.data?.orderBy,
      pageSize: currentState.data?.pageSize ?? 100,
    });
  });

  btnPagePrev.addEventListener("click", () => {
    const page = (currentState.data?.page ?? 0) - 1;
    if (page >= 0) {
      sendAction({
        type: "loadData",
        page,
        search: currentState.data?.search ?? "",
        orderBy: currentState.data?.orderBy,
        pageSize: currentState.data?.pageSize ?? 100,
      });
    }
  });

  btnPageNext.addEventListener("click", () => {
    const page = (currentState.data?.page ?? 0) + 1;
    sendAction({
      type: "loadData",
      page,
      search: currentState.data?.search ?? "",
      orderBy: currentState.data?.orderBy,
      pageSize: currentState.data?.pageSize ?? 100,
    });
  });

  selPageSize.addEventListener("change", () => {
    sendAction({
      type: "loadData",
      page: 0,
      search: currentState.data?.search ?? "",
      orderBy: currentState.data?.orderBy,
      pageSize: Number(selPageSize.value) || 100,
    });
  });

  // ── Consola SQL ─────────────────────────────────────────────────────────
  btnSqlRun.addEventListener("click", () => {
    const sql = sqlEditor.value.trim();
    if (sql) {
      sendAction({ type: "runSql", sql });
    }
  });

  sqlEditor.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      btnSqlRun.click();
    }
  });

  btnSqlClear.addEventListener("click", () => {
    sqlEditor.value = "";
    consoleResults.innerHTML = '<div class="db-console-placeholder">Los resultados de la consulta aparecerán aquí.</div>';
  });

  formConfirmSql.addEventListener("submit", (e) => {
    e.preventDefault();
    if (sqlConfirmInput.value.trim().toUpperCase() === "EJECUTAR") {
      closeModal(modalConfirmSql);
      sendAction({ type: "runSql", sql: sqlEditor.value, confirm: "EJECUTAR" });
    }
  });

  sqlConfirmInput.addEventListener("input", () => {
    btnSqlConfirmSubmit.disabled = sqlConfirmInput.value.trim().toUpperCase() !== "EJECUTAR";
  });

  // ── Gestión de perfiles ─────────────────────────────────────────────────
  btnProfileNew.addEventListener("click", () => {
    formProfile.reset();
    profId.value = "";
    document.getElementById("profile-modal-title").textContent = "NUEVA CONEXIÓN MARIADB";
    profName.value = "Nueva Conexión";
    profHost.value = "127.0.0.1";
    profPort.value = "3306";
    profUser.value = "root";
    profPass.value = "";
    profDatabase.value = "";
    profSsl.value = "off";

    profSshEnabled.checked = false;
    profSshFields.className = "db-fieldset-body hidden";
    profSshHost.value = "";
    profSshPort.value = "22";
    profSshUser.value = "";
    profSshAuth.value = "password";
    profSshPw.value = "";
    profSshKeypath.value = "";
    profSshPassphrase.value = "";
    updateSshAuthVisibility();

    openModal(modalProfile);
    profName.focus();
  });

  btnProfileEdit.addEventListener("click", () => {
    const id = selProfile.value || currentState.activeProfileId;
    const p = currentState.profiles?.find((x) => x.id === id);
    if (!p) return;

    formProfile.reset();
    document.getElementById("profile-modal-title").textContent = "EDITAR CONEXIÓN MARIADB";
    profId.value = p.id;
    profName.value = p.name;
    profHost.value = p.host;
    profPort.value = String(p.port);
    profUser.value = p.user;
    profPass.value = "";
    profPass.placeholder = p.hasPassword ? "(Sin cambiar: contraseña guardada)" : "(Sin contraseña)";
    profDatabase.value = p.database || "";
    profSsl.value = p.ssl;

    const t = p.tunnel || {};
    profSshEnabled.checked = Boolean(t.enabled);
    profSshFields.className = t.enabled ? "db-fieldset-body" : "db-fieldset-body hidden";
    profSshHost.value = t.host || "";
    profSshPort.value = String(t.port || 22);
    profSshUser.value = t.user || "";
    profSshAuth.value = t.auth || "password";

    profSshPw.value = "";
    profSshPw.placeholder = p.hasSshPassword ? "(Sin cambiar: guardada)" : "";

    profSshKeypath.value = t.keyPath || "";
    profSshPassphrase.value = "";
    profSshPassphrase.placeholder = p.hasSshPassphrase ? "(Sin cambiar: guardada)" : "";

    updateSshAuthVisibility();

    openModal(modalProfile);
    profName.focus();
  });

  btnProfileDel.addEventListener("click", () => {
    const id = selProfile.value || currentState.activeProfileId;
    const p = currentState.profiles?.find((x) => x.id === id);
    if (!p) return;

    openDestructiveConfirm(
      "ELIMINAR CONEXIÓN",
      `¿Deseas eliminar el perfil de conexión "${p.name}"?`,
      p.name,
      () => {
        sendAction({ type: "deleteProfile", id: p.id });
      }
    );
  });

  profSshEnabled.addEventListener("change", () => {
    profSshFields.className = profSshEnabled.checked ? "db-fieldset-body" : "db-fieldset-body hidden";
  });

  profSshAuth.addEventListener("change", updateSshAuthVisibility);

  function updateSshAuthVisibility() {
    const auth = profSshAuth.value;
    if (auth === "password") {
      profSshRowPw.className = "db-form-row";
      profSshRowKey.className = "db-form-cols hidden";
    } else if (auth === "key") {
      profSshRowPw.className = "db-form-row hidden";
      profSshRowKey.className = "db-form-cols";
    } else {
      profSshRowPw.className = "db-form-row hidden";
      profSshRowKey.className = "db-form-cols hidden";
    }
  }

  formProfile.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = profId.value.trim() || undefined;
    const name = profName.value.trim();
    const host = profHost.value.trim() || "127.0.0.1";
    const port = Number(profPort.value) || 3306;
    const user = profUser.value.trim();
    const database = profDatabase.value.trim() || undefined;
    const ssl = profSsl.value;

    const sshEnabled = profSshEnabled.checked;
    const tunnel = {
      enabled: sshEnabled,
      host: profSshHost.value.trim(),
      port: Number(profSshPort.value) || 22,
      user: profSshUser.value.trim(),
      auth: profSshAuth.value,
      keyPath: profSshKeypath.value.trim() || undefined,
    };

    const profile = {
      id: id || "",
      name,
      host,
      port,
      user,
      database,
      ssl,
      tunnel,
    };

    const action = {
      type: "saveProfile",
      profile,
    };

    if (profPass.value) {
      action.password = profPass.value;
    }
    if (profSshPw.value) {
      action.sshPassword = profSshPw.value;
    }
    if (profSshPassphrase.value) {
      action.sshPassphrase = profSshPassphrase.value;
    }

    closeModal(modalProfile);
    sendAction(action);
  });

  // ── Cancelar operación en curso y carpeta backup ─────────────────────────
  btnCancelOp.addEventListener("click", () => {
    sendAction({ type: "cancel" });
  });

  btnOpenBackupDir.addEventListener("click", () => {
    sendAction({ type: "openBackupFolder" });
  });

  // ── Modal de Confirmación Destructiva ────────────────────────────────────
  function openDestructiveConfirm(title, message, expected, onConfirm) {
    destructiveTitle.textContent = title;
    destructiveMsg.textContent = message;
    destructiveExpected.textContent = expected;
    destructiveInput.value = "";
    btnDestructiveSubmit.disabled = true;
    onDestructiveConfirm = onConfirm;

    openModal(modalConfirmDestructive);
    destructiveInput.focus();
  }

  destructiveInput.addEventListener("input", () => {
    const expected = destructiveExpected.textContent;
    btnDestructiveSubmit.disabled = destructiveInput.value.trim() !== expected;
  });

  formConfirmDestructive.addEventListener("submit", (e) => {
    e.preventDefault();
    if (destructiveInput.value.trim() === destructiveExpected.textContent) {
      closeModal(modalConfirmDestructive);
      if (onDestructiveConfirm) {
        onDestructiveConfirm();
        onDestructiveConfirm = null;
      }
    }
  });

  // ── Visor Hexadecimal ───────────────────────────────────────────────────
  function openHexViewer(colName, cellVal) {
    document.getElementById("hex-modal-title").textContent = `VISOR BINARIO: ${colName}`;
    hexInfo.textContent = `Tamaño: ${cellVal.bytes} bytes`;

    try {
      const binStr = atob(cellVal.b64);
      const lines = [];
      const len = binStr.length;

      for (let i = 0; i < len; i += 16) {
        const offset = i.toString(16).padStart(8, "0");
        const chunk = [];
        const ascii = [];

        for (let j = 0; j < 16; j++) {
          if (i + j < len) {
            const code = binStr.charCodeAt(i + j);
            chunk.push(code.toString(16).padStart(2, "0"));
            ascii.push(code >= 32 && code <= 126 ? String.fromCharCode(code) : ".");
          } else {
            chunk.push("  ");
          }
        }

        const left = chunk.slice(0, 8).join(" ");
        const right = chunk.slice(8).join(" ");
        lines.push(`${offset}  ${left}  ${right}  |${ascii.join("")}|`);
      }

      hexDump.textContent = lines.join("\n");
    } catch (e) {
      hexDump.textContent = `No se pudo decodificar el contenido binario: ${e.message}`;
    }

    openModal(modalHexViewer);
  }

  // ── Utilidades de modal ─────────────────────────────────────────────────
  function openModal(el) {
    el.classList.remove("hidden");
  }

  function closeModal(el) {
    el.classList.add("hidden");
  }

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-close");
      const target = document.getElementById(targetId);
      if (target) {
        closeModal(target);
      }
    });
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".db-modal-overlay:not(.hidden)").forEach((m) => {
        closeModal(m);
      });
    }
  });

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Notificar al host que el webview está listo
  vscode.postMessage({ type: "ready" });
})();

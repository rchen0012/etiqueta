/* Google Sheets is authoritative. Local storage is only a read-only offline cache. */
(() => {
  const config = window.PERSONNEL_CONFIG || {};
  let activeStore = '', epoch = 0;
  const cacheKey = (store, kind) => 'dafu:' + store + ':' + kind;
  const storeName = () => activeStore === 'beauty' ? 'DAFU BEUATY' : 'DAFU SHOP';
  let channel, peer, peerOrigin, readyPromise, token = '', sequence = 0;
  let people = [], revision = -1, latestApplied = 0, busy = false, refreshing = false;
  const pending = new Map();
  const validGoogleOrigin = origin => /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/i.test(origin);
  const status = text => { document.getElementById('personnelSyncStatus').textContent = text; };

  function connect() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(config.scriptUrl || '')) {
        reject(new Error('尚未配置 Google Sheets 连接，请先部署 Apps Script。'));
        return;
      }
      channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.title = 'Google Sheets 人员名单连接';
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handshake);
        frame.remove();
        readyPromise = null;
        reject(new Error('Google Sheets 连接超时，请检查脚本部署权限后刷新页面。'));
      }, 30000);
      function handshake(event) {
        if (!event.data || event.data.channel !== channel || !event.data.ready || !validGoogleOrigin(event.origin)) return;
        peer = event.source;
        peerOrigin = event.origin;
        clearTimeout(timeout);
        window.removeEventListener('message', handshake);
        resolve();
      }
      window.addEventListener('message', handshake);
      frame.src = config.scriptUrl + '?channel=' + channel;
      document.body.appendChild(frame);
    });
    return readyPromise;
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || event.source !== peer || event.origin !== peerOrigin || data.channel !== channel) return;
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    clearTimeout(item.timeout);
    if (data.error) item.reject(new Error(data.error));
    else item.resolve(data.result);
  });
  async function rpc(method, args = [], store = activeStore) {
    if (!store) throw new Error("请先选择部门。");
    await connect();
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('服务器响应超时，保存结果尚未确认。请刷新名单核对后再操作。'));
      }, 30000);
      pending.set(id, {resolve, reject, timeout});
      peer.postMessage({channel, id, method, args: [...args, store]}, peerOrigin);
    });
  }
  function applySnapshot(data, requestNumber, store = activeStore, requestEpoch = epoch) {
    if (!activeStore || store !== activeStore || requestEpoch !== epoch) return;
    if (!data || data.store !== activeStore) throw new Error("后台部门校验失败，已阻止加载其他部门的人员名单。");
    if (!data || !Number.isFinite(data.revision) || !Array.isArray(data.people) || data.people.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' || !['staff', 'packer'].includes(p.role))) throw new Error('服务器返回的人员名单格式无效。');
    if (data.revision < revision || (data.revision === revision && requestNumber < latestApplied)) return;
    revision = data.revision;
    latestApplied = requestNumber;
    people = data.people;
    appData.staffList = people.filter(p => p.role === 'staff').map(p => p.name);
    appData.packerList = people.filter(p => p.role === 'packer').map(p => p.name);
    try {
      localStorage.setItem(cacheKey(activeStore, 'staffList'), JSON.stringify(appData.staffList));
      localStorage.setItem(cacheKey(activeStore, 'packerList'), JSON.stringify(appData.packerList));
    } catch { /* A blocked cache must not turn a successful server write into failure. */ }
    loadStaffOptions();
    loadPackerOptions();
    renderStaffList();
    renderPackerList();
    validateForm();
    status(storeName() + ' · 已同步独立人员数据库 · ' + new Date().toLocaleTimeString());
  }
  let requestNumber = 0;
  window.refreshPersonnel = async function() {
    if (!activeStore || refreshing || busy) return;
    refreshing = true;
    const number = ++requestNumber, store = activeStore, requestEpoch = epoch;
    try {
      applySnapshot(await rpc('personnelList', [], store), number, store, requestEpoch);
    } catch (error) { if (requestEpoch === epoch) status(storeName() + ' · ' + error.message + ' 当前名单可能不是最新。'); }
    finally { if (requestEpoch === epoch) refreshing = false; }
  };
  function render(role, targetId) {
    const container = document.getElementById(targetId);
    container.replaceChildren();
    const rows = people.filter(p => p.role === role);
    if (!rows.length) { container.textContent = '暂无云端人员，请添加后保存。'; return; }
    for (const person of rows) {
      const item = document.createElement('div');
      item.className = 'person-item';
      const name = document.createElement('span');
      name.textContent = person.name;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-small btn-danger';
      button.textContent = '删除';
      button.disabled = busy;
      button.addEventListener('click', () => remove(person));
      item.append(name, button);
      container.appendChild(item);
    }
  }
  window.renderStaffList = () => render('staff', 'staffList');
  window.renderPackerList = () => render('packer', 'packerList');
  function setBusy(value) {
    busy = value;
    document.querySelectorAll('.add-person-form button').forEach(button => { button.disabled = value; });
    renderStaffList(); renderPackerList();
  }
  async function mutate(method, args) {
    if (!checkAdminPermission() || !token || busy) return false;
    setBusy(true);
    const number = ++requestNumber, store = activeStore, requestEpoch = epoch;
    try {
      const result = await rpc(method, [token, ...args], store);
      if (requestEpoch !== epoch || store !== activeStore) return false;
      applySnapshot(result, number, store, requestEpoch);
      showNotification('已保存到 ' + storeName() + ' 独立数据库', 'success');
      return true;
    } catch (error) {
      if (requestEpoch !== epoch) return false;
      status(error.message);
      showNotification(error.message, 'error');
      if (error.message.includes('登录')) {
        token = '';
        appData.isAdminLoggedIn = false;
        document.getElementById('loginForm').style.display = 'block';
        document.getElementById('managementContent').style.display = 'none';
      }
      return false;
    } finally { if (requestEpoch === epoch) setBusy(false); }
  }
  async function add(role, inputId) {
    const input = document.getElementById(inputId);
    const name = input.value.trim();
    if (!name) { showNotification('请输入姓名', 'error'); return; }
    if (await mutate('personnelAdd', [role, name])) input.value = '';
  }
  async function remove(person) {
    if (!confirm('确定删除 ' + person.name + '？')) return;
    await mutate('personnelDelete', [person.id]);
  }
  window.addStaff = () => add('staff', 'newStaffName');
  window.addPacker = () => add('packer', 'newPackerName');
  window.deleteStaff = index => { const p = people.filter(p => p.role === 'staff')[index]; if (p) return remove(p); };
  window.deletePacker = index => { const p = people.filter(p => p.role === 'packer')[index]; if (p) return remove(p); };
  let loggingIn = false;
  window.adminLogin = async function() {
    if (loggingIn) return;
    loggingIn = true;
    const store = activeStore, requestEpoch = epoch;
    const input = document.getElementById('adminPassword');
    const password = input.value;
    const username = document.getElementById('adminUsername').value.trim();
    input.value = '';
    try {
      const result = await rpc('personnelLogin', [username, password], store);
      if (requestEpoch !== epoch || store !== activeStore) return;
      if (!result || typeof result.token !== 'string' || !result.token) throw new Error('登录失败。');
      token = result.token;
      appData.isAdminLoggedIn = true;
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('managementContent').style.display = 'block';
      document.getElementById('loginError').style.display = 'none';
      await refreshPersonnel();
      showNotification('管理员登录成功', 'success');
    } catch (error) {
      if (requestEpoch !== epoch) return;
      token = '';
      appData.isAdminLoggedIn = false;
      const message = document.getElementById('loginError');
      message.textContent = error.message;
      message.style.display = 'block';
    } finally { if (requestEpoch === epoch) loggingIn = false; }
  };
  function cachedList(store, kind) {
    if (!store) return [];
    try {
      let raw = localStorage.getItem(cacheKey(store, kind));
      // Legacy data belonged to SHOP. It must never become BEUATY's starting list.
      if (raw === null && store === 'shop') raw = localStorage.getItem(kind);
      const list = JSON.parse(raw || '[]');
      return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
    } catch { return []; }
  }
  function changeDepartment(name) {
    const next = name === 'DAFU SHOP' ? 'shop' : name === 'DAFU BEUATY' ? 'beauty' : '';
    if (next === activeStore) return;
    activeStore = next; epoch++; token = ''; revision = -1; latestApplied = 0;
    people = []; busy = false; refreshing = false; loggingIn = false;
    appData.isAdminLoggedIn = false;
    appData.staffList = cachedList(next, 'staffList');
    appData.packerList = cachedList(next, 'packerList');
    document.getElementById('adminPassword').value = '';
    document.getElementById('adminUsername').value = '';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('managementContent').style.display = 'none';
    document.getElementById('loginForm').style.display = 'block';
    document.querySelectorAll('.add-person-form button').forEach(button => { button.disabled = false; });
    loadStaffOptions(); loadPackerOptions(); renderStaffList(); renderPackerList();
    resetForm();
    status(next ? storeName() + ' · 正在连接独立人员数据库…' : '请选择部门');
    if (next) refreshPersonnel();
  }
  window.addEventListener('departmentchange', event => changeDepartment(event.detail));
  document.addEventListener('DOMContentLoaded', () => {
    changeDepartment(typeof selectedDepartment === 'string' ? selectedDepartment : '');
    setInterval(() => { if (!document.hidden) refreshPersonnel(); }, 30000);
    window.addEventListener('focus', () => refreshPersonnel());
  });
})();

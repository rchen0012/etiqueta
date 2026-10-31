/* Google Sheets is authoritative. Local storage is only a read-only offline cache. */
(() => {
  const config = window.PERSONNEL_CONFIG || {};
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
  async function rpc(method, args = []) {
    await connect();
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('服务器响应超时，保存结果尚未确认。请刷新名单核对后再操作。'));
      }, 30000);
      pending.set(id, {resolve, reject, timeout});
      peer.postMessage({channel, id, method, args}, peerOrigin);
    });
  }
  function applySnapshot(data, requestNumber) {
    if (!data || !Number.isFinite(data.revision) || !Array.isArray(data.people) || data.people.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' || !['staff', 'packer'].includes(p.role))) throw new Error('服务器返回的人员名单格式无效。');
    if (data.revision < revision || (data.revision === revision && requestNumber < latestApplied)) return;
    revision = data.revision;
    latestApplied = requestNumber;
    people = data.people;
    appData.staffList = people.filter(p => p.role === 'staff').map(p => p.name);
    appData.packerList = people.filter(p => p.role === 'packer').map(p => p.name);
    try {
      localStorage.setItem('staffList', JSON.stringify(appData.staffList));
      localStorage.setItem('packerList', JSON.stringify(appData.packerList));
    } catch { /* A blocked cache must not turn a successful server write into failure. */ }
    loadStaffOptions();
    loadPackerOptions();
    renderStaffList();
    renderPackerList();
    validateForm();
    status('已同步 Google Sheets · ' + new Date().toLocaleTimeString());
  }
  let requestNumber = 0;
  window.refreshPersonnel = async function() {
    if (refreshing || busy) return;
    refreshing = true;
    const number = ++requestNumber;
    try {
      applySnapshot(await rpc('personnelList'), number);
    } catch (error) { status(error.message + ' 当前名单可能不是最新。'); }
    finally { refreshing = false; }
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
    const number = ++requestNumber;
    try {
      const result = await rpc(method, [token, ...args]);
      applySnapshot(result, number);
      showNotification('已保存到 Google Sheets', 'success');
      return true;
    } catch (error) {
      status(error.message);
      showNotification(error.message, 'error');
      if (error.message.includes('登录')) {
        token = '';
        appData.isAdminLoggedIn = false;
        document.getElementById('loginForm').style.display = 'block';
        document.getElementById('managementContent').style.display = 'none';
      }
      return false;
    } finally { setBusy(false); }
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
    const input = document.getElementById('adminPassword');
    const password = input.value;
    const username = document.getElementById('adminUsername').value.trim();
    input.value = '';
    try {
      const result = await rpc('personnelLogin', [username, password]);
      if (!result || typeof result.token !== 'string' || !result.token) throw new Error('登录失败。');
      token = result.token;
      appData.isAdminLoggedIn = true;
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('managementContent').style.display = 'block';
      document.getElementById('loginError').style.display = 'none';
      await refreshPersonnel();
      showNotification('管理员登录成功', 'success');
    } catch (error) {
      token = '';
      appData.isAdminLoggedIn = false;
      const message = document.getElementById('loginError');
      message.textContent = error.message;
      message.style.display = 'block';
    } finally { loggingIn = false; }
  };
  document.addEventListener('DOMContentLoaded', () => {
    refreshPersonnel();
    setInterval(() => { if (!document.hidden) refreshPersonnel(); }, 30000);
    window.addEventListener('focus', () => refreshPersonnel());
  });
})();

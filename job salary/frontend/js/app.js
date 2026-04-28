const API_BASE_URL = 'http://localhost:5000/api';

let lastQueryParams = null;
let currentTaskId = null;
let currentDataPage = 1;
const DATA_PER_PAGE = 20;

document.addEventListener('DOMContentLoaded', () => {
    initTabNavigation();
    initForms();
    checkApiHealth();
});

function initTabNavigation() {
    const tabs = document.querySelectorAll('.nav-tab');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    const tabs = document.querySelectorAll('.nav-tab');
    const contents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(t => t.classList.remove('active'));
    contents.forEach(c => c.classList.remove('active'));
    
    const activeTab = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);
    const activeContent = document.getElementById(`tab-${tabName}`);
    
    if (activeTab) activeTab.classList.add('active');
    if (activeContent) activeContent.classList.add('active');
    
    if (tabName === 'crawl') {
        loadCrawlTasks();
    } else if (tabName === 'schedules') {
        loadSchedules();
    } else if (tabName === 'data') {
        loadDataOverview();
        loadDataList();
    }
}

function initForms() {
    const queryForm = document.getElementById('queryForm');
    if (queryForm) {
        queryForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await handleQuery();
        });
    }
    
    const crawlForm = document.getElementById('crawlForm');
    if (crawlForm) {
        crawlForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await handleStartCrawl();
        });
    }
    
    const scheduleForm = document.getElementById('scheduleForm');
    if (scheduleForm) {
        scheduleForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await handleCreateSchedule();
        });
    }
    
    const crawlJobType = document.getElementById('crawlJobType');
    if (crawlJobType) {
        crawlJobType.addEventListener('change', (e) => {
            const searchGroup = document.getElementById('searchKeywordGroup');
            const urlsGroup = document.getElementById('targetUrlsGroup');
            
            if (e.target.value === 'scrape_urls') {
                searchGroup.style.display = 'none';
                urlsGroup.style.display = 'block';
            } else {
                searchGroup.style.display = 'block';
                urlsGroup.style.display = 'none';
            }
        });
    }
    
    const cronExpression = document.getElementById('cronExpression');
    if (cronExpression) {
        cronExpression.addEventListener('change', (e) => {
            const customGroup = document.getElementById('customCronGroup');
            customGroup.style.display = e.target.value === 'custom' ? 'block' : 'none';
        });
    }
}

async function checkApiHealth() {
    try {
        const response = await fetch(`${API_BASE_URL}/health`);
        if (!response.ok) {
            console.warn('API health check failed');
        }
    } catch (error) {
        console.error('API health check error:', error);
    }
}

function getFormData(formId) {
    const form = document.getElementById(formId);
    if (!form) return {};
    
    const formData = new FormData(form);
    const data = {};
    
    for (let [key, value] of formData.entries()) {
        if (value !== '' && value !== null) {
            data[key] = value;
        }
    }
    
    return data;
}

function formatSalary(salary) {
    if (!salary) return '¥0';
    if (salary >= 10000) {
        return `¥${(salary / 10000).toFixed(2)}万`;
    }
    return `¥${Math.round(salary).toLocaleString('zh-CN')}`;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function setLoadingState(buttonId, isLoading) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    
    const btnText = btn.querySelector('.btn-text');
    const btnLoading = btn.querySelector('.btn-loading');
    
    btn.disabled = isLoading;
    
    if (btnText && btnLoading) {
        if (isLoading) {
            btnText.style.display = 'none';
            btnLoading.style.display = 'flex';
        } else {
            btnText.style.display = 'inline';
            btnLoading.style.display = 'none';
        }
    }
}

function hideAllSections() {
    const resultSection = document.getElementById('resultSection');
    const errorSection = document.getElementById('errorSection');
    
    if (resultSection) resultSection.style.display = 'none';
    if (errorSection) errorSection.style.display = 'none';
}

function showGlobalError(title, message) {
    const section = document.getElementById('globalErrorSection');
    const titleEl = document.getElementById('globalErrorTitle');
    const messageEl = document.getElementById('globalErrorMessage');
    
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (section) section.style.display = 'flex';
}

function hideGlobalError() {
    const section = document.getElementById('globalErrorSection');
    if (section) section.style.display = 'none';
}

function showModal(title, content, footerActions = null) {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const footerEl = document.getElementById('modalFooter');
    
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) {
        if (typeof content === 'string') {
            bodyEl.innerHTML = content;
        } else {
            bodyEl.innerHTML = '';
            bodyEl.appendChild(content);
        }
    }
    
    if (footerEl && footerActions) {
        footerEl.innerHTML = '';
        footerActions.forEach(action => {
            const btn = document.createElement('button');
            btn.className = `btn ${action.class || 'btn-secondary'}`;
            btn.textContent = action.label;
            btn.onclick = action.onClick || closeModal;
            footerEl.appendChild(btn);
        });
    }
    
    if (overlay) overlay.style.display = 'flex';
}

function closeModal() {
    const overlay = document.getElementById('modalOverlay');
    if (overlay) overlay.style.display = 'none';
}

async function handleQuery() {
    const params = getQueryFormData();
    lastQueryParams = { ...params };
    
    if (!params.position && !params.industry && !params.location) {
        displayError('请至少输入岗位、行业或工作地点中的一项');
        return;
    }
    
    setLoadingState('submitBtn', true);
    hideAllSections();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    
    try {
        const response = await fetch(`${API_BASE_URL}/salary/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(params),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            displayResults(result.data);
        } else {
            if (response.status === 408) {
                displayError('查询超时（40秒），请尝试减少筛选条件或稍后重试');
            } else {
                displayError(result.message || '查询失败，请稍后重试');
            }
        }
    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            displayError('查询超时（40秒），请尝试减少筛选条件或稍后重试');
        } else if (error.message.includes('fetch') || error.message.includes('network')) {
            displayError('无法连接到服务器，请检查后端服务是否已启动（运行 python backend/app.py）');
        } else {
            displayError('查询出错: ' + error.message);
        }
    } finally {
        setLoadingState('submitBtn', false);
    }
}

function getQueryFormData() {
    const position = document.getElementById('position')?.value?.trim() || '';
    const industry = document.getElementById('industry')?.value?.trim() || '';
    const gender = document.getElementById('gender')?.value;
    const ageMin = document.getElementById('ageMin')?.value;
    const ageMax = document.getElementById('ageMax')?.value;
    const experienceMin = document.getElementById('experienceMin')?.value;
    const experienceMax = document.getElementById('experienceMax')?.value;
    const location = document.getElementById('location')?.value?.trim() || '';
    const timePeriod = document.getElementById('timePeriod')?.value || 'month';
    
    const params = {
        position,
        industry,
        location,
        timePeriod
    };
    
    if (gender) params.gender = gender;
    if (ageMin) params.age_min = parseFloat(ageMin);
    if (ageMax) params.age_max = parseFloat(ageMax);
    if (experienceMin) params.experience_min = parseFloat(experienceMin);
    if (experienceMax) params.experience_max = parseFloat(experienceMax);
    
    return params;
}

function displayResults(data) {
    hideAllSections();
    
    const resultSection = document.getElementById('resultSection');
    if (!resultSection) return;
    
    resultSection.style.display = 'block';
    
    const timePeriodLabel = document.getElementById('timePeriodLabel');
    if (timePeriodLabel) timePeriodLabel.textContent = data.time_period;
    
    const stats = data.statistics;
    if (stats) {
        const maxSalary = document.getElementById('maxSalary');
        const minSalary = document.getElementById('minSalary');
        const meanSalary = document.getElementById('meanSalary');
        const medianSalary = document.getElementById('medianSalary');
        const sampleCount = document.getElementById('sampleCount');
        
        if (maxSalary) maxSalary.textContent = formatSalary(stats.max_salary);
        if (minSalary) minSalary.textContent = formatSalary(stats.min_salary);
        if (meanSalary) meanSalary.textContent = formatSalary(stats.weighted_mean_salary);
        if (medianSalary) medianSalary.textContent = formatSalary(stats.median_salary);
        if (sampleCount) sampleCount.textContent = stats.sample_count;
    }
    
    if (data.sample_records && data.sample_records.length > 0) {
        displaySampleRecords(data.sample_records);
    }
    
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function displaySampleRecords(records) {
    const sampleRecords = document.getElementById('sampleRecords');
    const tableBody = document.getElementById('recordsTableBody');
    
    if (!sampleRecords || !tableBody) return;
    
    tableBody.innerHTML = '';
    
    records.forEach(record => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(record.position)}</td>
            <td>${escapeHtml(record.industry)}</td>
            <td>${record.gender === 'male' ? '男' : record.gender === 'female' ? '女' : '-'}</td>
            <td>${record.age ? record.age + '岁' : '-'}</td>
            <td>${record.experience_years ? record.experience_years + '年' : '-'}</td>
            <td>${escapeHtml(record.location)}</td>
            <td class="salary-highlight">${formatSalary(record.last_salary)}</td>
            <td>${record.source_type === 'crawl' ? '<span class="tag tag-crawl">采集</span>' : '<span class="tag tag-manual">手动</span>'}</td>
        `;
        tableBody.appendChild(row);
    });
    
    sampleRecords.style.display = 'block';
}

function displayError(message) {
    hideAllSections();
    
    const errorSection = document.getElementById('errorSection');
    const errorMessage = document.getElementById('errorMessage');
    
    if (errorMessage) errorMessage.textContent = message;
    if (errorSection) errorSection.style.display = 'flex';
    
    if (errorSection) {
        errorSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function retryQuery() {
    if (lastQueryParams) {
        handleQuery();
    }
}

async function initTestData() {
    try {
        const response = await fetch(`${API_BASE_URL}/salary/init-test-data`, {
            method: 'POST'
        });
        const result = await response.json();
        if (result.success) {
            showModal('成功', `<p>${result.message}</p>`);
            loadDataOverview();
            loadDataList();
        } else {
            showGlobalError('初始化失败', result.message);
        }
    } catch (error) {
        showGlobalError('操作失败', '无法初始化测试数据，请确保后端服务已启动');
    }
}

async function handleStartCrawl() {
    const taskName = document.getElementById('crawlTaskName')?.value || '薪资数据采集';
    const jobType = document.getElementById('crawlJobType')?.value || 'search';
    
    let searchKeyword = null;
    let targetUrls = null;
    
    if (jobType === 'search') {
        searchKeyword = document.getElementById('searchKeyword')?.value?.trim();
        if (!searchKeyword) {
            showGlobalError('参数错误', '请输入搜索关键词');
            return;
        }
    } else {
        const urlsText = document.getElementById('targetUrls')?.value?.trim();
        if (!urlsText) {
            showGlobalError('参数错误', '请输入目标URL列表');
            return;
        }
        targetUrls = urlsText.split('\n').map(u => u.trim()).filter(u => u);
        if (targetUrls.length === 0) {
            showGlobalError('参数错误', '请输入有效的URL');
            return;
        }
    }
    
    setLoadingState('crawlSubmitBtn', true);
    
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                task_name: taskName,
                job_type: jobType,
                search_keyword: searchKeyword,
                target_urls: targetUrls
            })
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            showModal('任务已启动', `
                <p>采集任务已成功启动！</p>
                <p>任务ID: <code>${result.data.task_id}</code></p>
                <p>您可以在任务列表中查看进度。</p>
            `);
            loadCrawlTasks();
        } else {
            showGlobalError('启动失败', result.message || '启动采集任务失败');
        }
    } catch (error) {
        showGlobalError('操作失败', '无法连接到服务器: ' + error.message);
    } finally {
        setLoadingState('crawlSubmitBtn', false);
    }
}

async function loadCrawlTasks() {
    const tasksList = document.getElementById('tasksList');
    if (!tasksList) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/tasks`);
        const result = await response.json();
        
        if (response.ok && result.success && result.data.items.length > 0) {
            renderCrawlTasks(result.data.items);
        } else {
            tasksList.innerHTML = `
                <div class="empty-state">
                    <p>暂无采集任务</p>
                    <p class="hint">创建新任务开始数据采集</p>
                </div>
            `;
        }
    } catch (error) {
        tasksList.innerHTML = `
            <div class="empty-state">
                <p>加载失败</p>
                <p class="hint">无法获取任务列表，请检查后端服务</p>
            </div>
        `;
    }
}

function renderCrawlTasks(tasks) {
    const tasksList = document.getElementById('tasksList');
    if (!tasksList) return;
    
    tasksList.innerHTML = tasks.map(task => {
        const statusClass = `status-${task.status}`;
        const statusText = getStatusText(task.status);
        const progress = task.progress || 0;
        
        return `
            <div class="task-card" data-task-id="${task.task_id}">
                <div class="task-header">
                    <div class="task-info">
                        <h4>${escapeHtml(task.task_name)}</h4>
                        <p>类型: ${task.job_type === 'search' ? '搜索采集' : 'URL采集'} | 
                           ${task.search_keyword ? `关键词: ${escapeHtml(task.search_keyword)}` : ''}</p>
                    </div>
                    <span class="task-status ${statusClass}">${statusText}</span>
                </div>
                
                ${task.status === 'running' ? `
                    <div class="task-progress">
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${progress}%"></div>
                        </div>
                        <div class="progress-text">
                            <span>进度: ${progress}%</span>
                            <span>成功: ${task.success_count} | 失败: ${task.failed_count}</span>
                        </div>
                    </div>
                ` : ''}
                
                <div class="task-meta">
                    <span>创建时间: ${formatDateTime(task.created_at)}</span>
                    ${task.completed_at ? `<span>完成时间: ${formatDateTime(task.completed_at)}</span>` : ''}
                </div>
                
                <div class="task-actions">
                    <button class="btn btn-sm btn-primary" onclick="viewTaskDetail('${task.task_id}')">
                        查看详情
                    </button>
                    ${task.status === 'completed' ? `
                        <button class="btn btn-sm btn-success" onclick="viewTaskResults('${task.task_id}')">
                            查看结果
                        </button>
                    ` : ''}
                    ${task.status === 'running' ? `
                        <button class="btn btn-sm btn-warning" onclick="refreshTaskStatus('${task.task_id}')">
                            刷新状态
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function getStatusText(status) {
    const statusMap = {
        'pending': '等待中',
        'running': '运行中',
        'completed': '已完成',
        'failed': '失败'
    };
    return statusMap[status] || status;
}

function formatDateTime(isoString) {
    if (!isoString) return '-';
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN');
}

async function viewTaskDetail(taskId) {
    currentTaskId = taskId;
    
    const detailSection = document.getElementById('taskDetailSection');
    const detailContent = document.getElementById('taskDetailContent');
    const tasksListSection = document.querySelector('#tab-crawl > .query-section:nth-child(2)');
    
    if (!detailSection || !detailContent) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/tasks/${taskId}`);
        const result = await response.json();
        
        if (response.ok && result.success) {
            const task = result.data.task;
            const statusClass = `status-${task.status}`;
            const statusText = getStatusText(task.status);
            
            detailContent.innerHTML = `
                <div class="task-detail">
                    <p><strong>任务名称:</strong> ${escapeHtml(task.task_name)}</p>
                    <p><strong>任务ID:</strong> <code>${task.task_id}</code></p>
                    <p><strong>状态:</strong> <span class="task-status ${statusClass}">${statusText}</span></p>
                    <p><strong>类型:</strong> ${task.job_type === 'search' ? '搜索采集' : 'URL采集'}</p>
                    ${task.search_keyword ? `<p><strong>搜索关键词:</strong> ${escapeHtml(task.search_keyword)}</p>` : ''}
                    <p><strong>创建时间:</strong> ${formatDateTime(task.created_at)}</p>
                    ${task.started_at ? `<p><strong>开始时间:</strong> ${formatDateTime(task.started_at)}</p>` : ''}
                    ${task.completed_at ? `<p><strong>完成时间:</strong> ${formatDateTime(task.completed_at)}</p>` : ''}
                    <p><strong>进度:</strong> ${task.progress}%</p>
                    <p><strong>成功:</strong> ${task.success_count} | <strong>失败:</strong> ${task.failed_count}</p>
                    ${task.error_message ? `<p><strong>错误信息:</strong> ${escapeHtml(task.error_message)}</p>` : ''}
                </div>
            `;
            
            if (tasksListSection) tasksListSection.style.display = 'none';
            detailSection.style.display = 'block';
        }
    } catch (error) {
        showGlobalError('加载失败', '无法获取任务详情: ' + error.message);
    }
}

function closeTaskDetail() {
    const detailSection = document.getElementById('taskDetailSection');
    const resultsSection = document.getElementById('crawlResultsSection');
    const tasksListSection = document.querySelector('#tab-crawl > .query-section:nth-child(2)');
    
    if (detailSection) detailSection.style.display = 'none';
    if (resultsSection) resultsSection.style.display = 'none';
    if (tasksListSection) tasksListSection.style.display = 'block';
    
    currentTaskId = null;
}

async function refreshTaskStatus(taskId) {
    await viewTaskDetail(taskId);
    loadCrawlTasks();
}

async function viewTaskResults(taskId) {
    currentTaskId = taskId;
    
    const resultsSection = document.getElementById('crawlResultsSection');
    const resultsContent = document.getElementById('crawlResultsContent');
    const detailSection = document.getElementById('taskDetailSection');
    const tasksListSection = document.querySelector('#tab-crawl > .query-section:nth-child(2)');
    
    if (!resultsSection || !resultsContent) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/tasks/${taskId}/results?per_page=50`);
        const result = await response.json();
        
        if (response.ok && result.success) {
            renderCrawlResults(result.data);
            
            if (tasksListSection) tasksListSection.style.display = 'none';
            if (detailSection) detailSection.style.display = 'none';
            resultsSection.style.display = 'block';
        }
    } catch (error) {
        showGlobalError('加载失败', '无法获取采集结果: ' + error.message);
    }
}

function renderCrawlResults(data) {
    const resultsContent = document.getElementById('crawlResultsContent');
    if (!resultsContent) return;
    
    const items = data.items || [];
    
    if (items.length === 0) {
        resultsContent.innerHTML = `
            <div class="empty-state">
                <p>暂无采集结果</p>
                <p class="hint">该任务尚未产生任何结果</p>
            </div>
        `;
        return;
    }
    
    resultsContent.innerHTML = `
        <p style="margin-bottom: 15px; color: var(--text-secondary);">
            共 ${data.total} 条结果，当前显示 ${items.length} 条
        </p>
        <div class="tasks-list">
            ${items.map(item => {
                const statusClass = item.status === 'success' ? 'status-completed' : 
                                   item.status === 'failed' ? 'status-failed' : 'status-pending';
                const statusText = item.status === 'success' ? '成功' : 
                                  item.status === 'failed' ? '失败' : '待处理';
                
                return `
                    <div class="result-card">
                        <div class="result-card-header">
                            <div class="result-card-title">
                                ${item.position ? escapeHtml(item.position) : '未识别职位'}
                            </div>
                            <span class="task-status ${statusClass}">${statusText}</span>
                        </div>
                        
                        <div class="result-card-meta">
                            ${item.company_name ? `<span>公司: ${escapeHtml(item.company_name)}</span>` : ''}
                            ${item.location ? `<span>地点: ${escapeHtml(item.location)}</span>` : ''}
                            ${item.experience_required ? `<span>经验: ${escapeHtml(item.experience_required)}</span>` : ''}
                        </div>
                        
                        ${item.salary_avg ? `
                            <div class="result-card-salary">
                                ${formatSalary(item.salary_min)} - ${formatSalary(item.salary_max)}
                                ${item.salary_avg ? `(平均: ${formatSalary(item.salary_avg)})` : ''}
                            </div>
                        ` : ''}
                        
                        ${item.source_url ? `
                            <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 10px; word-break: break-all;">
                                来源: <a href="${escapeHtml(item.source_url)}" target="_blank" style="color: var(--primary-color);">${escapeHtml(item.source_url)}</a>
                            </p>
                        ` : ''}
                        
                        <div class="result-card-actions">
                            ${item.status === 'success' && !item.is_imported ? `
                                <button class="btn btn-sm btn-primary" onclick="importSingleResult('${item.id}')">
                                    导入薪资库
                                </button>
                            ` : ''}
                            ${item.is_imported ? `
                                <span style="color: var(--success-color); font-weight: 500;">
                                    ✓ 已导入 (记录ID: ${item.salary_record_id})
                                </span>
                            ` : ''}
                            ${item.error_message ? `
                                <span style="color: var(--danger-color);">
                                    错误: ${escapeHtml(item.error_message)}
                                </span>
                            ` : ''}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

async function importSingleResult(resultId) {
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/results/${resultId}/import`, {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            showModal('导入成功', `<p>${result.message}</p>`);
            if (currentTaskId) {
                viewTaskResults(currentTaskId);
            }
        } else {
            showGlobalError('导入失败', result.message || '导入失败');
        }
    } catch (error) {
        showGlobalError('操作失败', '无法连接到服务器: ' + error.message);
    }
}

async function importAllResults() {
    if (!currentTaskId) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/tasks/${currentTaskId}/import`, {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            showModal('导入完成', `
                <p>成功导入 ${result.data.imported_count} 条记录</p>
                <p>跳过 ${result.data.skipped_count} 条记录（已存在或数据不完整）</p>
                ${result.data.errors.length > 0 ? `
                    <p style="color: var(--danger-color); margin-top: 10px;">
                        错误: ${result.data.errors.join(', ')}
                    </p>
                ` : ''}
            `);
            if (currentTaskId) {
                viewTaskResults(currentTaskId);
            }
        } else {
            showGlobalError('导入失败', result.message || '导入失败');
        }
    } catch (error) {
        showGlobalError('操作失败', '无法连接到服务器: ' + error.message);
    }
}

async function handleCreateSchedule() {
    const scheduleName = document.getElementById('scheduleName')?.value?.trim();
    let cronExpression = document.getElementById('cronExpression')?.value;
    const jobType = document.getElementById('scheduleJobType')?.value || 'search';
    const searchKeyword = document.getElementById('scheduleKeyword')?.value?.trim();
    
    if (!scheduleName) {
        showGlobalError('参数错误', '请输入任务名称');
        return;
    }
    
    if (cronExpression === 'custom') {
        cronExpression = document.getElementById('customCron')?.value?.trim();
        if (!cronExpression) {
            showGlobalError('参数错误', '请输入Cron表达式');
            return;
        }
    }
    
    if (jobType === 'search' && !searchKeyword) {
        showGlobalError('参数错误', '请输入搜索关键词');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/schedules`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                schedule_name: scheduleName,
                cron_expression: cronExpression,
                job_type: jobType,
                search_keyword: searchKeyword
            })
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            showModal('创建成功', `<p>定时任务已创建！</p>`);
            loadSchedules();
        } else {
            showGlobalError('创建失败', result.message || '创建定时任务失败');
        }
    } catch (error) {
        showGlobalError('操作失败', '无法连接到服务器: ' + error.message);
    }
}

async function loadSchedules() {
    const schedulesList = document.getElementById('schedulesList');
    if (!schedulesList) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/schedules`);
        const result = await response.json();
        
        if (response.ok && result.success && result.data.items.length > 0) {
            renderSchedules(result.data.items);
        } else {
            schedulesList.innerHTML = `
                <div class="empty-state">
                    <p>暂无定时任务</p>
                    <p class="hint">创建定时任务自动采集数据</p>
                </div>
            `;
        }
    } catch (error) {
        schedulesList.innerHTML = `
            <div class="empty-state">
                <p>加载失败</p>
                <p class="hint">无法获取定时任务列表</p>
            </div>
        `;
    }
}

function renderSchedules(schedules) {
    const schedulesList = document.getElementById('schedulesList');
    if (!schedulesList) return;
    
    schedulesList.innerHTML = schedules.map(schedule => {
        const statusClass = schedule.is_active ? 'status-active' : 'status-inactive';
        const statusText = schedule.is_active ? '运行中' : '已暂停';
        
        return `
            <div class="task-card">
                <div class="task-header">
                    <div class="task-info">
                        <h4>${escapeHtml(schedule.schedule_name)}</h4>
                        <p>Cron: ${escapeHtml(schedule.cron_expression)} | 
                           关键词: ${escapeHtml(schedule.search_keyword || '-')}</p>
                    </div>
                    <span class="task-status ${statusClass}">${statusText}</span>
                </div>
                
                <div class="task-meta">
                    <span>创建时间: ${formatDateTime(schedule.created_at)}</span>
                    ${schedule.last_run_at ? `<span>上次执行: ${formatDateTime(schedule.last_run_at)} (${schedule.last_run_status || '-'})</span>` : ''}
                    ${schedule.next_run_at ? `<span>下次执行: ${formatDateTime(schedule.next_run_at)}</span>` : ''}
                </div>
                
                <div class="task-actions">
                    <button class="btn btn-sm ${schedule.is_active ? 'btn-warning' : 'btn-success'}" 
                            onclick="toggleSchedule('${schedule.schedule_id}', ${!schedule.is_active})">
                        ${schedule.is_active ? '暂停' : '启用'}
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteSchedule('${schedule.schedule_id}')">
                        删除
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function toggleSchedule(scheduleId, isActive) {
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/schedules/${scheduleId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                is_active: isActive
            })
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            loadSchedules();
        } else {
            showGlobalError('操作失败', result.message || '更新定时任务失败');
        }
    } catch (error) {
        showGlobalError('操作失败', '无法连接到服务器: ' + error.message);
    }
}

async function deleteSchedule(scheduleId) {
    if (!confirm('确定要删除这个定时任务吗？')) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/crawl/schedules/${scheduleId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            loadSchedules();
        } else {
            showGlobalError('删除失败', result.message || '删除定时任务失败');
        }
    } catch (error) {
        showGlobalError('操作失败', '无法连接到服务器: ' + error.message);
    }
}

async function loadDataOverview() {
    const overviewEl = document.getElementById('dataOverview');
    if (!overviewEl) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/salary/statistics`);
        const result = await response.json();
        
        if (response.ok && result.success) {
            const data = result.data;
            const stats = data.statistics || {};
            
            overviewEl.innerHTML = `
                <div class="data-overview">
                    <div class="overview-card">
                        <div class="overview-label">总记录数</div>
                        <div class="overview-value">${data.total_records || 0}</div>
                        <div class="overview-sub">条薪资记录</div>
                    </div>
                    <div class="overview-card secondary">
                        <div class="overview-label">平均薪资</div>
                        <div class="overview-value">${formatSalary(stats.weighted_mean_salary)}</div>
                        <div class="overview-sub">基于有效记录计算</div>
                    </div>
                    <div class="overview-card success">
                        <div class="overview-label">薪资范围</div>
                        <div class="overview-value">${formatSalary(stats.min_salary)} - ${formatSalary(stats.max_salary)}</div>
                        <div class="overview-sub">最低到最高</div>
                    </div>
                    <div class="overview-card warning">
                        <div class="overview-label">行业数量</div>
                        <div class="overview-value">${data.industries?.length || 0}</div>
                        <div class="overview-sub">个不同行业</div>
                    </div>
                </div>
            `;
        }
    } catch (error) {
        overviewEl.innerHTML = `
            <div class="empty-state">
                <p>加载失败</p>
                <p class="hint">无法获取数据概览</p>
            </div>
        `;
    }
}

async function loadDataList(page = 1) {
    currentDataPage = page;
    
    const tableBody = document.getElementById('dataTableBody');
    const paginationEl = document.getElementById('dataPagination');
    
    if (!tableBody) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/salary/list?page=${page}&per_page=${DATA_PER_PAGE}`);
        const result = await response.json();
        
        if (response.ok && result.success) {
            const data = result.data;
            
            tableBody.innerHTML = data.items.map(record => `
                <tr>
                    <td>${record.id}</td>
                    <td>${escapeHtml(record.position)}</td>
                    <td>${escapeHtml(record.industry)}</td>
                    <td>${escapeHtml(record.location)}</td>
                    <td class="salary-highlight">${formatSalary(record.last_salary)}</td>
                    <td>${record.experience_years ? record.experience_years + '年' : '-'}</td>
                    <td>
                        ${record.source_type === 'crawl' ? 
                            '<span class="tag tag-crawl">采集</span>' : 
                            '<span class="tag tag-manual">手动</span>'}
                    </td>
                    <td>${formatDateTime(record.created_at)}</td>
                </tr>
            `).join('');
            
            renderPagination(data.total, page, paginationEl);
        }
    } catch (error) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align: center; padding: 40px; color: var(--text-secondary);">
                    加载失败
                </td>
            </tr>
        `;
    }
}

function renderPagination(total, currentPage, container) {
    if (!container) return;
    
    const totalPages = Math.ceil(total / DATA_PER_PAGE);
    
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }
    
    let html = '<span class="pagination-info">共 ' + total + ' 条记录</span>';
    
    if (currentPage > 1) {
        html += `<button onclick="loadDataList(${currentPage - 1})">上一页</button>`;
    }
    
    const startPage = Math.max(1, currentPage - 2);
    const endPage = Math.min(totalPages, currentPage + 2);
    
    for (let i = startPage; i <= endPage; i++) {
        const activeClass = i === currentPage ? 'active' : '';
        html += `<button class="${activeClass}" onclick="loadDataList(${i})">${i}</button>`;
    }
    
    if (currentPage < totalPages) {
        html += `<button onclick="loadDataList(${currentPage + 1})">下一页</button>`;
    }
    
    container.innerHTML = html;
}

import os
import statistics
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, request, jsonify
from flask_cors import CORS

from models import db, SalaryRecord, CrawlTask, CrawlResult, ScheduledCrawl
from crawl_service import crawl_service
from scheduler_service import scheduler_service

app = Flask(__name__)
CORS(app)

basedir = os.path.abspath(os.path.dirname(__file__))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(basedir, 'salary.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

with app.app_context():
    db.create_all()

scheduler_service.init_app(app)

if os.environ.get('WERKZEUG_RUN_MAIN') == 'true' or not app.debug:
    scheduler_service.start()

def get_time_range(time_period):
    now = datetime.utcnow()
    if time_period == 'week':
        return now - timedelta(days=7)
    elif time_period == 'month':
        return now - timedelta(days=30)
    elif time_period == 'half_year':
        return now - timedelta(days=183)
    elif time_period == 'year':
        return now - timedelta(days=365)
    else:
        return now - timedelta(days=365)

def calculate_statistics(salaries):
    if not salaries:
        return None
    
    max_salary = float(max(salaries))
    min_salary = float(min(salaries))
    mean_salary = float(statistics.mean(salaries))
    median_salary = float(statistics.median(salaries))
    
    return {
        'max_salary': max_salary,
        'min_salary': min_salary,
        'weighted_mean_salary': mean_salary,
        'median_salary': median_salary,
        'sample_count': len(salaries)
    }

@app.route('/api/salary/query', methods=['POST'])
def query_salary():
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({
                'success': False,
                'message': '请提供查询条件'
            }), 400
        
        position = data.get('position', '').strip()
        industry = data.get('industry', '').strip()
        gender = data.get('gender')
        age_min = data.get('age_min')
        age_max = data.get('age_max')
        experience_min = data.get('experience_min')
        experience_max = data.get('experience_max')
        location = data.get('location', '').strip()
        time_period = data.get('time_period', 'month')
        
        if not position and not industry and not location:
            return jsonify({
                'success': False,
                'message': '请至少输入岗位、行业或工作地点中的一项'
            }), 400
        
        time_cutoff = get_time_range(time_period)
        
        query = SalaryRecord.query.filter(SalaryRecord.created_at >= time_cutoff)
        
        if position:
            query = query.filter(SalaryRecord.position.contains(position))
        if industry:
            query = query.filter(SalaryRecord.industry.contains(industry))
        if gender and gender in ['male', 'female']:
            query = query.filter(SalaryRecord.gender == gender)
        if age_min is not None:
            query = query.filter(SalaryRecord.age >= age_min)
        if age_max is not None:
            query = query.filter(SalaryRecord.age <= age_max)
        if experience_min is not None:
            query = query.filter(SalaryRecord.experience_years >= experience_min)
        if experience_max is not None:
            query = query.filter(SalaryRecord.experience_years <= experience_max)
        if location:
            query = query.filter(SalaryRecord.location.contains(location))
        
        records = query.all()
        
        if not records:
            return jsonify({
                'success': False,
                'message': '未找到符合条件的薪资记录，请尝试调整筛选条件'
            }), 404
        
        salaries = [r.last_salary for r in records]
        statistics = calculate_statistics(salaries)
        
        time_period_labels = {
            'week': '一周内',
            'month': '30天内',
            'half_year': '半年内',
            'year': '一年内'
        }
        
        return jsonify({
            'success': True,
            'data': {
                'statistics': statistics,
                'time_period': time_period_labels.get(time_period, '30天内'),
                'records_count': len(records),
                'sample_records': [r.to_dict() for r in records[:5]]
            }
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'查询出错: {str(e)}'
        }), 500

@app.route('/api/salary/add', methods=['POST'])
def add_salary():
    try:
        data = request.get_json()
        
        required_fields = ['position', 'industry', 'location', 'last_salary']
        for field in required_fields:
            if not data.get(field):
                return jsonify({
                    'success': False,
                    'message': f'缺少必填字段: {field}'
                }), 400
        
        record = SalaryRecord(
            position=data['position'],
            industry=data['industry'],
            gender=data.get('gender'),
            age=data.get('age'),
            experience_years=data.get('experience_years'),
            location=data['location'],
            last_salary=data['last_salary']
        )
        
        db.session.add(record)
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': '薪资记录添加成功',
            'data': record.to_dict()
        }), 201
        
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'message': f'添加失败: {str(e)}'
        }), 500

@app.route('/api/salary/list', methods=['GET'])
def list_salaries():
    try:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 20, type=int)
        
        query = SalaryRecord.query.order_by(SalaryRecord.created_at.desc())
        total = query.count()
        
        records = query.offset((page - 1) * per_page).limit(per_page).all()
        
        return jsonify({
            'success': True,
            'data': {
                'total': total,
                'page': page,
                'per_page': per_page,
                'items': [r.to_dict() for r in records]
            }
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'获取列表失败: {str(e)}'
        }), 500

@app.route('/api/salary/statistics', methods=['GET'])
def get_overall_statistics():
    try:
        records = SalaryRecord.query.all()
        
        if not records:
            return jsonify({
                'success': True,
                'data': {
                    'total_records': 0,
                    'industries': [],
                    'locations': [],
                    'statistics': None
                }
            })
        
        salaries = [r.last_salary for r in records]
        stats = calculate_statistics(salaries)
        
        from sqlalchemy import func
        
        industry_stats = db.session.query(
            SalaryRecord.industry,
            func.count(SalaryRecord.id).label('count'),
            func.avg(SalaryRecord.last_salary).label('avg_salary')
        ).group_by(SalaryRecord.industry).all()
        
        location_stats = db.session.query(
            SalaryRecord.location,
            func.count(SalaryRecord.id).label('count'),
            func.avg(SalaryRecord.last_salary).label('avg_salary')
        ).group_by(SalaryRecord.location).all()
        
        return jsonify({
            'success': True,
            'data': {
                'total_records': len(records),
                'statistics': stats,
                'industries': [
                    {'name': s.industry, 'count': s.count, 'avg_salary': round(s.avg_salary, 2)}
                    for s in industry_stats
                ],
                'locations': [
                    {'name': s.location, 'count': s.count, 'avg_salary': round(s.avg_salary, 2)}
                    for s in location_stats
                ]
            }
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'获取统计数据失败: {str(e)}'
        }), 500

@app.route('/api/salary/init-test-data', methods=['POST'])
def init_test_data():
    try:
        from datetime import datetime, timedelta
        import random
        
        positions = ['前端开发工程师', '后端开发工程师', '产品经理', '数据分析师', 'UI设计师',
                     'Java开发工程师', 'Python开发工程师', '测试工程师', '运维工程师', '架构师',
                     '销售经理', '市场专员', '人力资源专员', '财务会计', '行政助理',
                     '项目经理', '技术总监', '运营经理', '客服专员', '算法工程师']
        
        industries = ['互联网', '金融', '教育', '医疗健康', '制造业', '零售', '房地产', '物流',
                      '文化传媒', '新能源', '人工智能', '电子商务', '游戏', '咨询服务', '外包服务']
        
        locations = ['北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '武汉',
                     '西安', '重庆', '天津', '长沙', '郑州', '青岛', '大连', '厦门', '宁波']
        
        genders = ['male', 'female']
        
        db.session.query(SalaryRecord).delete()
        
        test_records = []
        now = datetime.utcnow()
        
        for i in range(500):
            base_salary = random.randint(8000, 35000)
            experience = random.uniform(0, 15)
            age = int(22 + experience + random.uniform(0, 5))
            
            days_ago = random.randint(0, 400)
            created_at = now - timedelta(days=days_ago)
            
            record = SalaryRecord(
                position=random.choice(positions),
                industry=random.choice(industries),
                gender=random.choice(genders),
                age=age,
                experience_years=round(experience, 1),
                location=random.choice(locations),
                last_salary=base_salary,
                created_at=created_at
            )
            test_records.append(record)
        
        db.session.bulk_save_objects(test_records)
        db.session.commit()
        
        return jsonify({
            'success': True,
            'message': f'成功初始化 {len(test_records)} 条测试数据'
        })
        
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'message': f'初始化失败: {str(e)}'
        }), 500

@app.route('/api/crawl/start', methods=['POST'])
def start_crawl():
    try:
        data = request.get_json()
        
        task_name = data.get('task_name', '薪资数据采集')
        job_type = data.get('job_type', 'search')
        search_keyword = data.get('search_keyword')
        target_urls = data.get('target_urls')
        
        if job_type == 'search' and not search_keyword:
            return jsonify({
                'success': False,
                'message': '搜索类型任务需要提供搜索关键词'
            }), 400
        
        if job_type == 'scrape_urls' and not target_urls:
            return jsonify({
                'success': False,
                'message': 'URL采集类型任务需要提供目标URL列表'
            }), 400
        
        task_id = crawl_service.start_crawl_task(
            task_name=task_name,
            job_type=job_type,
            search_keyword=search_keyword,
            target_urls=target_urls
        )
        
        return jsonify({
            'success': True,
            'message': '采集任务已启动',
            'data': {
                'task_id': task_id
            }
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'启动采集任务失败: {str(e)}'
        }), 500

@app.route('/api/crawl/tasks', methods=['GET'])
def list_crawl_tasks():
    try:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 20, type=int)
        
        query = CrawlTask.query.order_by(CrawlTask.created_at.desc())
        total = query.count()
        
        tasks = query.offset((page - 1) * per_page).limit(per_page).all()
        
        return jsonify({
            'success': True,
            'data': {
                'total': total,
                'page': page,
                'per_page': per_page,
                'items': [t.to_dict() for t in tasks]
            }
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'获取任务列表失败: {str(e)}'
        }), 500

@app.route('/api/crawl/tasks/<task_id>', methods=['GET'])
def get_crawl_task(task_id):
    try:
        status = crawl_service.get_task_status(task_id)
        
        if not status:
            return jsonify({
                'success': False,
                'message': '任务不存在'
            }), 404
        
        return jsonify({
            'success': True,
            'data': status
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'获取任务状态失败: {str(e)}'
        }), 500

@app.route('/api/crawl/tasks/<task_id>/results', methods=['GET'])
def get_crawl_results(task_id):
    try:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 20, type=int)
        status_filter = request.args.get('status')
        
        results = crawl_service.get_task_results(task_id, page, per_page)
        
        return jsonify({
            'success': True,
            'data': results
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'获取采集结果失败: {str(e)}'
        }), 500

@app.route('/api/crawl/tasks/<task_id>/import', methods=['POST'])
def import_crawl_results(task_id):
    try:
        result = crawl_service.import_all_results(task_id)
        
        return jsonify({
            'success': True,
            'message': f'成功导入 {result["imported_count"]} 条记录',
            'data': result
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'导入失败: {str(e)}'
        }), 500

@app.route('/api/crawl/results/<result_id>/import', methods=['POST'])
def import_single_result(result_id):
    try:
        result = CrawlResult.query.get(result_id)
        
        if not result:
            return jsonify({
                'success': False,
                'message': '结果记录不存在'
            }), 404
        
        record = crawl_service.import_to_salary_record(result)
        
        if record:
            return jsonify({
                'success': True,
                'message': '导入成功',
                'data': record.to_dict()
            })
        else:
            return jsonify({
                'success': True,
                'message': '记录已存在或数据不完整，已跳过'
            })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'导入失败: {str(e)}'
        }), 500

@app.route('/api/crawl/schedules', methods=['GET'])
def list_schedules():
    try:
        schedules = ScheduledCrawl.query.order_by(ScheduledCrawl.created_at.desc()).all()
        
        return jsonify({
            'success': True,
            'data': {
                'items': [s.to_dict() for s in schedules]
            }
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'获取定时任务列表失败: {str(e)}'
        }), 500

@app.route('/api/crawl/schedules', methods=['POST'])
def create_schedule():
    try:
        import uuid
        data = request.get_json()
        
        schedule_name = data.get('schedule_name')
        cron_expression = data.get('cron_expression')
        job_type = data.get('job_type', 'search')
        search_keyword = data.get('search_keyword')
        target_urls = data.get('target_urls')
        
        if not schedule_name or not cron_expression:
            return jsonify({
                'success': False,
                'message': '任务名称和Cron表达式为必填项'
            }), 400
        
        schedule = ScheduledCrawl(
            schedule_id=str(uuid.uuid4()),
            schedule_name=schedule_name,
            cron_expression=cron_expression,
            job_type=job_type,
            search_keyword=search_keyword,
            target_urls=','.join(target_urls) if target_urls else None,
            is_active=True
        )
        
        db.session.add(schedule)
        db.session.commit()
        
        scheduler_service.add_schedule(schedule)
        
        return jsonify({
            'success': True,
            'message': '定时任务创建成功',
            'data': schedule.to_dict()
        }), 201
        
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'message': f'创建定时任务失败: {str(e)}'
        }), 500

@app.route('/api/crawl/schedules/<schedule_id>', methods=['PUT'])
def update_schedule(schedule_id):
    try:
        schedule = ScheduledCrawl.query.filter_by(schedule_id=schedule_id).first()
        
        if not schedule:
            return jsonify({
                'success': False,
                'message': '定时任务不存在'
            }), 404
        
        data = request.get_json()
        
        if 'schedule_name' in data:
            schedule.schedule_name = data['schedule_name']
        if 'cron_expression' in data:
            schedule.cron_expression = data['cron_expression']
        if 'is_active' in data:
            schedule.is_active = data['is_active']
        if 'search_keyword' in data:
            schedule.search_keyword = data['search_keyword']
        
        db.session.commit()
        
        scheduler_service.update_schedule(schedule)
        
        return jsonify({
            'success': True,
            'message': '定时任务更新成功',
            'data': schedule.to_dict()
        })
        
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'message': f'更新定时任务失败: {str(e)}'
        }), 500

@app.route('/api/crawl/schedules/<schedule_id>', methods=['DELETE'])
def delete_schedule(schedule_id):
    try:
        schedule = ScheduledCrawl.query.filter_by(schedule_id=schedule_id).first()
        
        if not schedule:
            return jsonify({
                'success': False,
                'message': '定时任务不存在'
            }), 404
        
        db.session.delete(schedule)
        db.session.commit()
        
        scheduler_service.delete_schedule(schedule_id)
        
        return jsonify({
            'success': True,
            'message': '定时任务删除成功'
        })
        
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'message': f'删除定时任务失败: {str(e)}'
        }), 500

@app.route('/api/config/anycrawl', methods=['GET'])
def get_anycrawl_config():
    return jsonify({
        'success': True,
        'data': {
            'api_url': os.environ.get('ANYCRAWL_API_URL', 'http://localhost:8080/v1'),
            'api_key_configured': bool(os.environ.get('ANYCRAWL_API_KEY', ''))
        }
    })

@app.route('/api/config/scheduler', methods=['GET'])
def get_scheduler_config():
    return jsonify({
        'success': True,
        'data': scheduler_service.get_scheduler_status()
    })

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'ok', 'message': '服务运行正常'})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)

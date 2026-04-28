import os
import json
import hashlib
import threading
import requests
from datetime import datetime
from typing import List, Dict, Optional, Any
from concurrent.futures import ThreadPoolExecutor, as_completed

from models import db, CrawlTask, CrawlResult, SalaryRecord

ANYCRAWL_API_URL = os.environ.get('ANYCRAWL_API_URL', 'http://localhost:8080/v1')
ANYCRAWL_API_KEY = os.environ.get('ANYCRAWL_API_KEY', '')

MAX_CONCURRENT_REQUESTS = 5
REQUEST_TIMEOUT = 60

PLATFORMS = {
    'zhaopin': {
        'name': '智联招聘',
        'base_url': 'https://www.zhaopin.com',
        'search_template': 'https://www.zhaopin.com/sou/jl{location}/kw{keyword}'
    },
    'liepin': {
        'name': '猎聘',
        'base_url': 'https://www.liepin.com',
        'search_template': 'https://www.liepin.com/zhaopin/?key={keyword}&dqs={location}'
    },
    'kanzhun': {
        'name': '看准网',
        'base_url': 'https://www.kanzhun.com',
        'search_template': 'https://www.kanzhun.com/search?k={keyword}'
    },
    'zhiyouji': {
        'name': '职友集',
        'base_url': 'https://www.jobui.com',
        'search_template': 'https://www.jobui.com/jobs?jobKw={keyword}'
    }
}

SALARY_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "positions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "position_name": {
                        "type": "string",
                        "description": "职位名称，如：前端开发工程师、Java开发工程师"
                    },
                    "company_name": {
                        "type": "string",
                        "description": "公司名称"
                    },
                    "salary_text": {
                        "type": "string",
                        "description": "薪资原文，如：15-25K·14薪、20-30K/月"
                    },
                    "salary_min": {
                        "type": "number",
                        "description": "薪资下限（月收入），如15K则为15000"
                    },
                    "salary_max": {
                        "type": "number",
                        "description": "薪资上限（月收入），如25K则为25000"
                    },
                    "location": {
                        "type": "string",
                        "description": "工作地点，如：北京、上海、广州、深圳"
                    },
                    "experience_required": {
                        "type": "string",
                        "description": "经验要求，如：3-5年、1-3年、不限"
                    },
                    "education_required": {
                        "type": "string",
                        "description": "学历要求，如：本科、大专、不限"
                    },
                    "industry": {
                        "type": "string",
                        "description": "所属行业，如：互联网、金融、教育"
                    }
                },
                "required": ["position_name", "salary_text", "location"]
            }
        }
    },
    "required": ["positions"]
}

class CrawlService:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
        })
        if ANYCRAWL_API_KEY:
            self.session.headers.update({
                'Authorization': f'Bearer {ANYCRAWL_API_KEY}'
            })
        self._running_tasks: Dict[str, threading.Thread] = {}
    
    def _call_anycrawl_api(self, endpoint: str, payload: Dict) -> Dict[str, Any]:
        url = f'{ANYCRAWL_API_URL}/{endpoint}'
        try:
            response = self.session.post(
                url,
                json=payload,
                timeout=REQUEST_TIMEOUT
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            raise Exception(f'AnyCrawl API调用失败: {str(e)}')
    
    def scrape_page(self, url: str, json_schema: Dict = None) -> Dict[str, Any]:
        payload = {
            'url': url,
            'formats': ['markdown', 'json'] if json_schema else ['markdown'],
            'only_main_content': True
        }
        
        if json_schema:
            payload['json_options'] = {
                'schema': json_schema,
                'user_prompt': '从页面中提取职位和薪资信息。如果是搜索结果页，请提取所有可见的职位信息。'
            }
        
        return self._call_anycrawl_api('scrape', payload)
    
    def search_jobs(self, keyword: str, limit: int = 10) -> List[Dict]:
        payload = {
            'query': f'{keyword} 招聘 薪资',
            'limit': limit,
            'lang': 'zh-CN'
        }
        
        result = self._call_anycrawl_api('search', payload)
        
        if result.get('success') and result.get('data'):
            return result['data']
        return []
    
    def parse_salary_text(self, salary_text: str) -> Dict:
        if not salary_text:
            return {'min': None, 'max': None, 'avg': None}
        
        salary_text = salary_text.upper().strip()
        
        import re
        numbers = re.findall(r'(\d+\.?\d*)', salary_text)
        
        if not numbers:
            return {'min': None, 'max': None, 'avg': None}
        
        multiplier = 1
        if 'K' in salary_text:
            multiplier = 1000
        elif 'W' in salary_text or '万' in salary_text:
            multiplier = 10000
        
        nums = [float(n) * multiplier for n in numbers]
        
        if len(nums) == 1:
            return {'min': nums[0], 'max': nums[0], 'avg': nums[0]}
        elif len(nums) >= 2:
            min_sal = min(nums[0], nums[1])
            max_sal = max(nums[0], nums[1])
            return {
                'min': min_sal,
                'max': max_sal,
                'avg': (min_sal + max_sal) / 2
            }
        
        return {'min': None, 'max': None, 'avg': None}
    
    def generate_hash(self, position: str, company: str, location: str, salary: float) -> str:
        key = f"{position}:{company}:{location}:{salary}"
        return hashlib.sha256(key.encode()).hexdigest()
    
    def deduplicate_result(self, position_data: Dict) -> bool:
        hash_sig = self.generate_hash(
            position_data.get('position_name', ''),
            position_data.get('company_name', ''),
            position_data.get('location', ''),
            position_data.get('salary_avg', 0)
        )
        
        existing = SalaryRecord.query.filter_by(hash_signature=hash_sig).first()
        return existing is not None
    
    def import_to_salary_record(self, crawl_result: CrawlResult) -> Optional[SalaryRecord]:
        if crawl_result.is_imported:
            return None
        
        if not crawl_result.position or not crawl_result.salary_avg:
            return None
        
        hash_sig = self.generate_hash(
            crawl_result.position,
            crawl_result.company_name or '',
            crawl_result.location or '',
            crawl_result.salary_avg
        )
        
        existing = SalaryRecord.query.filter_by(hash_signature=hash_sig).first()
        if existing:
            crawl_result.is_imported = True
            crawl_result.salary_record_id = existing.id
            db.session.commit()
            return None
        
        salary_record = SalaryRecord(
            position=crawl_result.position,
            industry=crawl_result.industry or '未知',
            location=crawl_result.location or '未知',
            last_salary=crawl_result.salary_avg,
            experience_years=self._parse_experience(crawl_result.experience_required),
            source_type='crawl',
            source_url=crawl_result.source_url,
            source_platform=crawl_result.source_platform,
            hash_signature=hash_sig
        )
        
        db.session.add(salary_record)
        crawl_result.is_imported = True
        
        db.session.commit()
        
        crawl_result.salary_record_id = salary_record.id
        db.session.commit()
        
        return salary_record
    
    def _parse_experience(self, experience_text: str) -> Optional[float]:
        if not experience_text:
            return None
        
        import re
        nums = re.findall(r'(\d+)', experience_text)
        
        if not nums:
            if '不限' in experience_text or '应届' in experience_text:
                return 0
            return None
        
        if len(nums) == 1:
            return float(nums[0])
        elif len(nums) >= 2:
            return (float(nums[0]) + float(nums[1])) / 2
        
        return None
    
    def _execute_crawl_task(self, task_id: str):
        task = CrawlTask.query.filter_by(task_id=task_id).first()
        if not task:
            return
        
        task.status = 'running'
        task.started_at = datetime.utcnow()
        db.session.commit()
        
        try:
            all_results = []
            
            if task.job_type == 'search':
                search_results = self.search_jobs(task.search_keyword or '招聘', limit=10)
                task.total_items = len(search_results)
                db.session.commit()
                
                for idx, result in enumerate(search_results):
                    try:
                        url = result.get('url')
                        if not url:
                            continue
                        
                        scrape_result = self.scrape_page(url, SALARY_JSON_SCHEMA)
                        
                        crawl_result = CrawlResult(
                            task_id=task_id,
                            source_url=url,
                            source_platform=result.get('source', 'search'),
                            raw_data=json.dumps(scrape_result, ensure_ascii=False)
                        )
                        
                        if scrape_result.get('success') and scrape_result.get('data'):
                            data = scrape_result['data']
                            positions = data.get('json', {}).get('positions', [])
                            
                            for pos in positions:
                                salary_info = self.parse_salary_text(pos.get('salary_text', ''))
                                
                                pos_result = CrawlResult(
                                    task_id=task_id,
                                    source_url=url,
                                    source_platform=result.get('source', 'search'),
                                    position=pos.get('position_name'),
                                    company_name=pos.get('company_name'),
                                    location=pos.get('location'),
                                    salary_min=salary_info['min'],
                                    salary_max=salary_info['max'],
                                    salary_avg=salary_info['avg'],
                                    experience_required=pos.get('experience_required'),
                                    education_required=pos.get('education_required'),
                                    industry=pos.get('industry'),
                                    status='success'
                                )
                                db.session.add(pos_result)
                                all_results.append(pos_result)
                            
                            crawl_result.status = 'success' if positions else 'no_data'
                        else:
                            crawl_result.status = 'failed'
                            crawl_result.error_message = scrape_result.get('message', '抓取失败')
                        
                        db.session.add(crawl_result)
                        
                        task.progress = int((idx + 1) / task.total_items * 100)
                        task.success_count += 1
                        db.session.commit()
                        
                    except Exception as e:
                        task.failed_count += 1
                        db.session.commit()
                        continue
            
            elif task.job_type == 'scrape_urls' and task.target_urls:
                urls = json.loads(task.target_urls) if isinstance(task.target_urls, str) else task.target_urls
                task.total_items = len(urls)
                db.session.commit()
                
                for idx, url in enumerate(urls):
                    try:
                        scrape_result = self.scrape_page(url, SALARY_JSON_SCHEMA)
                        
                        if scrape_result.get('success') and scrape_result.get('data'):
                            data = scrape_result['data']
                            positions = data.get('json', {}).get('positions', [])
                            
                            for pos in positions:
                                salary_info = self.parse_salary_text(pos.get('salary_text', ''))
                                
                                pos_result = CrawlResult(
                                    task_id=task_id,
                                    source_url=url,
                                    position=pos.get('position_name'),
                                    company_name=pos.get('company_name'),
                                    location=pos.get('location'),
                                    salary_min=salary_info['min'],
                                    salary_max=salary_info['max'],
                                    salary_avg=salary_info['avg'],
                                    experience_required=pos.get('experience_required'),
                                    education_required=pos.get('education_required'),
                                    industry=pos.get('industry'),
                                    status='success',
                                    raw_data=json.dumps(pos, ensure_ascii=False)
                                )
                                db.session.add(pos_result)
                                all_results.append(pos_result)
                        
                        task.progress = int((idx + 1) / task.total_items * 100)
                        task.success_count += 1
                        db.session.commit()
                        
                    except Exception as e:
                        task.failed_count += 1
                        db.session.commit()
                        continue
            
            task.status = 'completed'
            task.completed_at = datetime.utcnow()
            db.session.commit()
            
        except Exception as e:
            task.status = 'failed'
            task.error_message = str(e)
            task.completed_at = datetime.utcnow()
            db.session.commit()
        
        finally:
            if task_id in self._running_tasks:
                del self._running_tasks[task_id]
    
    def start_crawl_task(self, task_name: str, job_type: str = 'search', 
                         search_keyword: str = None, target_urls: List[str] = None) -> str:
        import uuid
        task_id = str(uuid.uuid4())
        
        task = CrawlTask(
            task_id=task_id,
            task_name=task_name,
            job_type=job_type,
            search_keyword=search_keyword,
            target_urls=json.dumps(target_urls) if target_urls else None,
            status='pending'
        )
        db.session.add(task)
        db.session.commit()
        
        thread = threading.Thread(
            target=self._execute_crawl_task,
            args=(task_id,),
            daemon=True
        )
        thread.start()
        self._running_tasks[task_id] = thread
        
        return task_id
    
    def get_task_status(self, task_id: str) -> Optional[Dict]:
        task = CrawlTask.query.filter_by(task_id=task_id).first()
        if not task:
            return None
        
        results = CrawlResult.query.filter_by(task_id=task_id).all()
        
        return {
            'task': task.to_dict(),
            'results_count': len(results),
            'is_running': task_id in self._running_tasks
        }
    
    def get_task_results(self, task_id: str, page: int = 1, per_page: int = 20) -> Dict:
        task = CrawlTask.query.filter_by(task_id=task_id).first()
        if not task:
            return {'total': 0, 'items': []}
        
        query = CrawlResult.query.filter_by(task_id=task_id)
        total = query.count()
        
        results = query.order_by(CrawlResult.created_at.desc()).offset(
            (page - 1) * per_page
        ).limit(per_page).all()
        
        return {
            'total': total,
            'page': page,
            'per_page': per_page,
            'items': [r.to_dict() for r in results]
        }
    
    def import_all_results(self, task_id: str) -> Dict:
        results = CrawlResult.query.filter_by(
            task_id=task_id,
            is_imported=False,
            status='success'
        ).all()
        
        imported_count = 0
        skipped_count = 0
        errors = []
        
        for result in results:
            try:
                record = self.import_to_salary_record(result)
                if record:
                    imported_count += 1
                else:
                    skipped_count += 1
            except Exception as e:
                errors.append(str(e))
                continue
        
        return {
            'imported_count': imported_count,
            'skipped_count': skipped_count,
            'errors': errors
        }


crawl_service = CrawlService()

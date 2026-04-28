from datetime import datetime
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class SalaryRecord(db.Model):
    __tablename__ = 'salary_records'
    
    id = db.Column(db.Integer, primary_key=True)
    position = db.Column(db.String(100), nullable=False)
    industry = db.Column(db.String(100), nullable=False)
    gender = db.Column(db.String(10), nullable=True)
    age = db.Column(db.Integer, nullable=True)
    experience_years = db.Column(db.Float, nullable=True)
    location = db.Column(db.String(100), nullable=False)
    last_salary = db.Column(db.Float, nullable=False)
    
    source_type = db.Column(db.String(20), default='manual')
    source_url = db.Column(db.String(500), nullable=True)
    source_platform = db.Column(db.String(50), nullable=True)
    is_verified = db.Column(db.Boolean, default=False)
    hash_signature = db.Column(db.String(64), nullable=True, unique=True)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'position': self.position,
            'industry': self.industry,
            'gender': self.gender,
            'age': self.age,
            'experience_years': self.experience_years,
            'location': self.location,
            'last_salary': self.last_salary,
            'source_type': self.source_type,
            'source_url': self.source_url,
            'source_platform': self.source_platform,
            'is_verified': self.is_verified,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }

class CrawlTask(db.Model):
    __tablename__ = 'crawl_tasks'
    
    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.String(36), unique=True, nullable=False)
    task_name = db.Column(db.String(100), nullable=False)
    
    job_type = db.Column(db.String(20), default='search')
    search_keyword = db.Column(db.String(200), nullable=True)
    target_urls = db.Column(db.Text, nullable=True)
    
    status = db.Column(db.String(20), default='pending')
    progress = db.Column(db.Integer, default=0)
    total_items = db.Column(db.Integer, default=0)
    success_count = db.Column(db.Integer, default=0)
    failed_count = db.Column(db.Integer, default=0)
    
    error_message = db.Column(db.Text, nullable=True)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    started_at = db.Column(db.DateTime, nullable=True)
    completed_at = db.Column(db.DateTime, nullable=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'task_id': self.task_id,
            'task_name': self.task_name,
            'job_type': self.job_type,
            'search_keyword': self.search_keyword,
            'status': self.status,
            'progress': self.progress,
            'total_items': self.total_items,
            'success_count': self.success_count,
            'failed_count': self.failed_count,
            'error_message': self.error_message,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'started_at': self.started_at.isoformat() if self.started_at else None,
            'completed_at': self.completed_at.isoformat() if self.completed_at else None
        }

class ScheduledCrawl(db.Model):
    __tablename__ = 'scheduled_crawls'
    
    id = db.Column(db.Integer, primary_key=True)
    schedule_id = db.Column(db.String(36), unique=True, nullable=False)
    schedule_name = db.Column(db.String(100), nullable=False)
    
    job_type = db.Column(db.String(20), default='search')
    search_keyword = db.Column(db.String(200), nullable=True)
    target_urls = db.Column(db.Text, nullable=True)
    
    cron_expression = db.Column(db.String(100), nullable=False)
    is_active = db.Column(db.Boolean, default=True)
    
    last_run_at = db.Column(db.DateTime, nullable=True)
    last_run_status = db.Column(db.String(20), nullable=True)
    next_run_at = db.Column(db.DateTime, nullable=True)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'schedule_id': self.schedule_id,
            'schedule_name': self.schedule_name,
            'job_type': self.job_type,
            'search_keyword': self.search_keyword,
            'cron_expression': self.cron_expression,
            'is_active': self.is_active,
            'last_run_at': self.last_run_at.isoformat() if self.last_run_at else None,
            'last_run_status': self.last_run_status,
            'next_run_at': self.next_run_at.isoformat() if self.next_run_at else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }

class CrawlResult(db.Model):
    __tablename__ = 'crawl_results'
    
    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.String(36), nullable=False)
    
    source_url = db.Column(db.String(500), nullable=False)
    source_platform = db.Column(db.String(50), nullable=True)
    
    position = db.Column(db.String(100), nullable=True)
    industry = db.Column(db.String(100), nullable=True)
    location = db.Column(db.String(100), nullable=True)
    salary_min = db.Column(db.Float, nullable=True)
    salary_max = db.Column(db.Float, nullable=True)
    salary_avg = db.Column(db.Float, nullable=True)
    experience_required = db.Column(db.String(50), nullable=True)
    education_required = db.Column(db.String(50), nullable=True)
    company_name = db.Column(db.String(100), nullable=True)
    
    raw_data = db.Column(db.Text, nullable=True)
    status = db.Column(db.String(20), default='pending')
    error_message = db.Column(db.Text, nullable=True)
    
    is_imported = db.Column(db.Boolean, default=False)
    salary_record_id = db.Column(db.Integer, nullable=True)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'task_id': self.task_id,
            'source_url': self.source_url,
            'source_platform': self.source_platform,
            'position': self.position,
            'industry': self.industry,
            'location': self.location,
            'salary_min': self.salary_min,
            'salary_max': self.salary_max,
            'salary_avg': self.salary_avg,
            'experience_required': self.experience_required,
            'education_required': self.education_required,
            'company_name': self.company_name,
            'status': self.status,
            'error_message': self.error_message,
            'is_imported': self.is_imported,
            'salary_record_id': self.salary_record_id,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }

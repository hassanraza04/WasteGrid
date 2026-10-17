-- Existing events deliberately retain unknown historical statuses (NULL).
alter table wastegrid.events
    add column report_state varchar(30)
        check (report_state in ('received','needs_info','needs_review','linked_to_job')),
    add column job_status varchar(30)
        check (job_status in ('unassigned','assigned','in_progress','blocked','completed','recheck_requested'));

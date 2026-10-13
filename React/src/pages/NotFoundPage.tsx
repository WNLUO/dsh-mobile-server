/*
 * 404 兜底页。路由表最后一条通配走这里。
 */
import { Link } from 'react-router-dom';
import { buttonVariants } from '@appica/ui-react/button';
import { PageHeading } from '../components/blocks';

export function NotFoundPage() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeading>页面不存在</PageHeading>
      <Link to="/" className={buttonVariants({ variant: 'outline', size: 'md' })}>
        返回个人中心
      </Link>
    </div>
  );
}

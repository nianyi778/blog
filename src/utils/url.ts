export const withBase = (path: string): string => {
	const base = import.meta.env.BASE_URL || '/';
	if (!path) return base;
	if (base === '/') return path;
	const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
	const cleanPath = path.startsWith('/') ? path : `/${path}`;
	return `${cleanBase}${cleanPath}`;
};

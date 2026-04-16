import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';

const LazyChart = ({ children, height = 300 }) => {
    const [isVisible, setIsVisible] = useState(false);
    const containerRef = useRef(null);

    useEffect(() => {
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    observer.disconnect();
                    setIsVisible(true);
                }
            },
            {
                root: null,
                rootMargin: '800px',
                threshold: 0
            }
        );

        if (containerRef.current) {
            observer.observe(containerRef.current);
        }

        return () => {
            if (observer) observer.disconnect();
        };
    }, []);

    return (
        <div ref={containerRef} style={{ height: height, width: '100%', position: 'relative' }}>
            <div style={{ 
                opacity: isVisible ? 1 : 0, 
                transition: 'opacity 0.3s ease-in',
                height: '100%',
                width: '100%'
            }}>
                {isVisible && children}
            </div>
            
            <div className="lazy-placeholder" style={{
                position: 'absolute',
                top: 0,
                left: 0,
                height: '100%',
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255,255,255,0.02)',
                borderRadius: 8,
                zIndex: -1
            }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
                    {isVisible ? null : <RefreshCw className="spinner" size={20} opacity={0.5} />}
                    <span style={{ fontSize: '0.8rem' }}>{isVisible ? '' : 'Loading Chart...'}</span>
                </div>
            </div>
        </div>
    );
};

export default LazyChart;

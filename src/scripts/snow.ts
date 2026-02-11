/**
 * 雪のエフェクトを開始し、それを停止するための関数を返す
 * @param parentElement 雪を降らせる親となるHTML要素
 * @returns 停止用の関数
 */
export function startSnowing(parentElement: HTMLElement): () => void {
    const COUNT = 200;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    let width = parentElement.clientWidth;
    let height = parentElement.clientHeight;
    let animationFrameId: number;

    class Snowflake {
        x: number = 0;
        y: number = 0;
        vy: number = 0;
        vx: number = 0;
        r: number = 0;
        o: number = 0;

        constructor() {
            this.reset();
        }

        reset() {
            this.x = Math.random() * width;
            this.y = Math.random() * -height;
            this.vy = 0.2 + Math.random() * 1;
            this.vx = 0.3 - Math.random();
            this.r = 0.5 + Math.random() * 1.5;
            this.o = 0.3 + Math.random() * 0.5;
        }

        update() {
            this.y += this.vy;
            this.x += this.vx;
            if (this.y > height) {
                this.reset();
            }
        }

        draw() {
            ctx.globalAlpha = this.o;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2, false);
            ctx.closePath();
            ctx.fill();
        }
    }

    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.pointerEvents = 'none'; // 操作を邪魔しない
    canvas.style.zIndex = '50'; // コンテンツ（100）より奥、背景より手前
    // 背景画像がある場合は重なり順を調整

    const snowflakes: Snowflake[] = [];
    for (let i = 0; i < COUNT; i++) {
        snowflakes.push(new Snowflake());
    }

    function loop() {
        ctx.clearRect(0, 0, width, height);
        snowflakes.forEach(s => {
            s.update();
            s.draw();
        });
        animationFrameId = requestAnimationFrame(loop);
    }

    function onResize() {
        width = parentElement.clientWidth;
        height = parentElement.clientHeight;
        canvas.width = width;
        canvas.height = height;
        ctx.fillStyle = '#FFF';
    }

    onResize();
    window.addEventListener('resize', onResize);
    parentElement.appendChild(canvas);
    loop();

    // クリーンアップ関数
    return () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(animationFrameId);
        if (canvas.parentElement) {
            parentElement.removeChild(canvas);
        }
    };
}